using System.Collections.Generic;
using UniVRM10;
using UnityEngine;

namespace AiWorld.Agents
{
    /// <summary>
    /// The body of a character: a VRM model driven by a humanoid Animator. It sits on the model's root (next to the
    /// Animator) and does what the clips cannot know about the world:
    ///
    ///  * cross-fades between body states (walk, sit, type, lie), so every change of pose is a blend over time;
    ///  * places a hand on a target with IK (a door handle, a fridge door, a laptop lid) and blends it in and out;
    ///  * keeps the feet planted on the floor while sitting, so the legs never hang into a seat or a mattress;
    ///  * on a bed, keeps the arms clear of the character's own torso and thighs (see <see cref="ArmClearance"/>);
    ///  * turns the head and the eyes toward what the character attends to, and blinks;
    ///  * lifts or lowers the whole model so the hips rest on the seat or the mattress, whatever the avatar's size,
    ///    and on a bed fits the body (clothes included) onto the mattress's surface, so it never sinks into it;
    ///  * gives the body capsule colliders, so doors stop against it and the blanket lies over it.
    /// </summary>
    [RequireComponent(typeof(Animator))]
    public class AvatarRig : MonoBehaviour
    {
        public const string Locomotion = "Locomotion", Sit = "Sit", Type = "Type", Lie = "Lie", Eat = "Eat",
            SitLean = "SitLean", Stoop = "Stoop", SwingIn = "SwingIn", SwingOut = "SwingOut", LieBack = "LieBack", LieKnees = "LieKnees", SitUp = "SitUp";

        Animator anim;
        Vrm10Instance vrm;
        Transform hips;
        float hipsOffset, hipsVelocity;
        float? hipsTarget;
        readonly HandIk left = new(), right = new();
        Vector3? feetAt;
        Vector3 feetForward;
        float feetWeight;
        /// <summary>how fast the feet go over to their planted place (weight per second): at once, a walking stance jumped 25 degrees at the knee</summary>
        float feetRate = FeetSlow;
        const float FeetSlow = 1.6f, FeetQuick = 6f;
        float ankleHeight = 0.08f, thighLength = 0.4f, shinLength = 0.4f, hipWidth = 0.18f;
        Vector3? lookAt;
        float lookWeight;
        Transform eyeTarget;
        float nextBlink = 2f, blinkT = -1f;
        string state = Locomotion;

        public Animator Animator => anim;
        public float Height { get; private set; } = 1.6f;
        public CapsuleCollider[] BodyCapsules { get; private set; } = new CapsuleCollider[0];
        /// <summary>
        /// fat capsules for cloth only (a blanket): round both thighs, both shins, the torso, and round each arm. Cloth collides
        /// at its vertices (~6 cm apart), so it slips round thin limb capsules, and the clothes (wide sleeves, skirts)
        /// stick out further than the body. <see cref="FitClothCapsules"/> sizes them to the outfit as it lies.
        /// </summary>
        public CapsuleCollider[] ClothCapsules { get; private set; } = new CapsuleCollider[0];
        ClothProxy[] proxies;

        class ClothProxy
        {
            public CapsuleCollider c;
            public HumanBodyBones a1, a2, b1, b2;
            public float extend, minRadius;
            public float size;     // the fitted radius; the collider's radius is this times the fades
            public float fade = 1f, fadeTarget = 1f;   // this capsule alone (an arm reaching out from under the quilt)
            public bool trimStart, trimEnd;   // pull that rounded end in by the radius, so it stops at the bone (chest, shoulder)
            public Vector3 A, B;   // the axis, last update
        }
        public string State => state;
        /// <summary>lying, or on the way down or up (the bed clips)</summary>
        public bool Lying => state == Lie || state == LieBack || state == LieKnees || state == SitUp;
        bool OnBedMoving => state == SwingIn || state == SwingOut || state == LieBack || state == LieKnees || state == SitUp || (surface && Live.Walking);
        Transform headBone;

        class HandIk
        {
            public Transform target;
            public Vector3 offset;
            public float weight, goal;
            public Vector3? surfaceNormal;   // in the target's space: the hand lies flat on this surface, palm toward it
            public Vector3 surfacePoint;     // a point on that surface, in the target's space
            public float push;               // how far the wrist has backed off so the fingertips stay outside it
            public float back, backGoal;     // how far the hand has drawn away from the surface before letting go
        }

        /// <summary>how far fingertip joints stay off a surface they rest on (m): a finger is about this thick</summary>
        const float FingerClear = 0.014f;
        /// <summary>lying down, a hand reaches at most this share of the arm's length, so the elbow never locks straight</summary>
        const float LyingReach = 0.93f;
        static readonly (HumanBodyBones middle, HumanBodyBones end)[] LeftFingers =
        {
            (HumanBodyBones.LeftThumbIntermediate, HumanBodyBones.LeftThumbDistal), (HumanBodyBones.LeftIndexIntermediate, HumanBodyBones.LeftIndexDistal),
            (HumanBodyBones.LeftMiddleIntermediate, HumanBodyBones.LeftMiddleDistal), (HumanBodyBones.LeftRingIntermediate, HumanBodyBones.LeftRingDistal),
            (HumanBodyBones.LeftLittleIntermediate, HumanBodyBones.LeftLittleDistal),
        };
        static readonly (HumanBodyBones middle, HumanBodyBones end)[] RightFingers =
        {
            (HumanBodyBones.RightThumbIntermediate, HumanBodyBones.RightThumbDistal), (HumanBodyBones.RightIndexIntermediate, HumanBodyBones.RightIndexDistal),
            (HumanBodyBones.RightMiddleIntermediate, HumanBodyBones.RightMiddleDistal), (HumanBodyBones.RightRingIntermediate, HumanBodyBones.RightRingDistal),
            (HumanBodyBones.RightLittleIntermediate, HumanBodyBones.RightLittleDistal),
        };

        void Awake()
        {
            anim = GetComponent<Animator>();
            anim.applyRootMotion = false;
            anim.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            vrm = GetComponent<Vrm10Instance>();
            hips = anim.GetBoneTransform(HumanBodyBones.Hips);
            headBone = anim.GetBoneTransform(HumanBodyBones.Head);
            var head = anim.GetBoneTransform(HumanBodyBones.Head);
            if (head) Height = head.position.y - transform.position.y + 0.12f;
            var lf = anim.GetBoneTransform(HumanBodyBones.LeftFoot);
            var rf = anim.GetBoneTransform(HumanBodyBones.RightFoot);
            var lt = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            var lk = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg);
            if (lf) ankleHeight = Mathf.Max(0.04f, lf.position.y - transform.position.y);
            if (lt && lk) thighLength = Vector3.Distance(lt.position, lk.position);
            if (lk && lf) shinLength = Vector3.Distance(lk.position, lf.position);
            if (lf && rf) hipWidth = Mathf.Clamp(Vector3.Distance(lf.position, rf.position), 0.12f, 0.3f);
            eyeTarget = new GameObject("EyeTarget").transform;
            eyeTarget.SetParent(transform.parent, false);
            if (vrm)
            {
                vrm.LookAtTargetType = VRM10ObjectLookAt.LookAtTargetTypes.SpecifiedTransform;
                vrm.LookAtTarget = eyeTarget;
            }
            armClearance = new ArmClearance(anim, transform);
            Live = new LiveMotion(anim, transform);
            // a body that bends far from its T-pose leaves the bounds Unity keeps for each mesh, and the face and hair
            // were culled while the body was still in view
            foreach (var smr in GetComponentsInChildren<SkinnedMeshRenderer>()) smr.updateWhenOffscreen = true;
            BuildCapsules();
            BuildClothProxies();
        }

        void BuildClothProxies()
        {
            float sc = Height / 1.6f;
            ClothProxy Make(string name, float r, HumanBodyBones a1, HumanBodyBones a2, HumanBodyBones b1, HumanBodyBones b2, float extend, bool trimStart = false, bool trimEnd = false)
            {
                var g = new GameObject(name);
                g.transform.SetParent(transform, false);
                g.layer = gameObject.layer;
                var c = g.AddComponent<CapsuleCollider>();
                c.isTrigger = true;     // for cloth only: no physics with doors or furniture
                c.direction = 2;
                c.radius = r;
                return new ClothProxy { c = c, a1 = a1, a2 = a2, b1 = b1, b2 = b2, extend = extend, minRadius = r, size = r, trimStart = trimStart, trimEnd = trimEnd };
            }
            proxies = new[]
            {
                // the legs side by side: thighs and shins apart, so bent knees stay under the blanket
                Make("Cloth Thighs", 0.15f * sc, HumanBodyBones.LeftUpperLeg, HumanBodyBones.RightUpperLeg, HumanBodyBones.LeftLowerLeg, HumanBodyBones.RightLowerLeg, 0.02f * sc),
                Make("Cloth Shins", 0.12f * sc, HumanBodyBones.LeftLowerLeg, HumanBodyBones.RightLowerLeg, HumanBodyBones.LeftFoot, HumanBodyBones.RightFoot, 0.12f * sc),
                // the torso ends at the neck with its round end pulled in, so it never reaches round the head
                Make("Cloth Torso", 0.17f * sc, HumanBodyBones.Hips, HumanBodyBones.Hips, HumanBodyBones.Neck, HumanBodyBones.Neck, 0f, trimEnd: true),
                Make("Cloth Left Arm", 0.06f * sc, HumanBodyBones.LeftUpperArm, HumanBodyBones.LeftUpperArm, HumanBodyBones.LeftHand, HumanBodyBones.LeftHand, 0.08f * sc, trimStart: true),
                Make("Cloth Right Arm", 0.06f * sc, HumanBodyBones.RightUpperArm, HumanBodyBones.RightUpperArm, HumanBodyBones.RightHand, HumanBodyBones.RightHand, 0.08f * sc, trimStart: true),
            };
            ClothCapsules = System.Array.ConvertAll(proxies, x => x.c);
            UpdateClothProxies();
        }

        void UpdateClothProxies()
        {
            if (proxies == null) return;
            foreach (var x in proxies)
            {
                var ta1 = anim.GetBoneTransform(x.a1); var ta2 = anim.GetBoneTransform(x.a2);
                var tb1 = anim.GetBoneTransform(x.b1); var tb2 = anim.GetBoneTransform(x.b2);
                if (!ta1 || !ta2 || !tb1 || !tb2) { x.c.enabled = false; continue; }
                var a = (ta1.position + ta2.position) * 0.5f;
                var b = (tb1.position + tb2.position) * 0.5f;
                var d = b - a;
                if (d.sqrMagnitude < 1e-6f) continue;
                b += d.normalized * x.extend;   // past the ankles over the feet, past the wrists over the hands
                x.fade = Mathf.MoveTowards(x.fade, x.fadeTarget, Time.deltaTime / 0.3f);
                x.c.radius = Mathf.Max(0.005f, x.size * clothFade * x.fade);
                float len = (b - a).magnitude, r = x.c.radius;
                var dir = (b - a) / len;
                if (x.trimEnd) b -= dir * Mathf.Min(r, len * 0.45f);
                if (x.trimStart) a += dir * Mathf.Min(r, len * 0.45f);
                x.A = a;
                x.B = b;
                x.c.transform.SetPositionAndRotation((a + b) * 0.5f, Quaternion.LookRotation(b - a));
                x.c.height = (b - a).magnitude + x.c.radius * 2f;
            }
        }

        /// <summary>
        /// size the cloth capsules to the outfit in the pose it is in now (call it once lying down): every vertex of
        /// the avatar's meshes goes to the nearest capsule axis, and each capsule grows to enclose 99% of the
        /// upper half of its vertices (the half the blanket rests on; hair spread under the body does not count).
        /// Returns the world height of the top of the chest.
        /// </summary>
        public float FitClothCapsules(float maxRadius = 0.28f)
        {
            UpdateClothProxies();
            var dists = new List<float>[proxies.Length];
            for (int i = 0; i < proxies.Length; i++) dists[i] = new List<float>();
            var baked = new Mesh();
            var head = anim.GetBoneTransform(HumanBodyBones.Head);
            foreach (var smr in GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                if (!smr.enabled || !smr.sharedMesh) continue;
                smr.BakeMesh(baked, true);
                var m = Matrix4x4.TRS(smr.transform.position, smr.transform.rotation, Vector3.one);
                var verts = baked.vertices;
                for (int v = 0; v < verts.Length; v += 2)        // every other vertex is plenty
                {
                    var w = m.MultiplyPoint3x4(verts[v]);
                    if (head && (w - head.position).sqrMagnitude < 0.03f) continue;   // the head and face stay uncovered
                    int best = -1;
                    float bestD = float.MaxValue, bestAxisY = 0;
                    for (int i = 0; i < proxies.Length; i++)
                    {
                        var x = proxies[i];
                        if (!x.c.enabled) continue;
                        var ab = x.B - x.A;
                        float tRaw = Vector3.Dot(w - x.A, ab) / ab.sqrMagnitude;
                        float t = Mathf.Clamp01(tRaw);
                        var onAxis = x.A + ab * t;
                        float dd = (w - onAxis).sqrMagnitude;
                        // past the ends (hair spread on the pillow above the head) does not size anything
                        bool alongside = tRaw > -0.05f && tRaw < 1.05f;
                        if (dd < bestD) { bestD = dd; best = alongside ? i : -1; bestAxisY = onAxis.y; }
                    }
                    if (best >= 0 && w.y >= bestAxisY) dists[best].Add(Mathf.Sqrt(bestD));
                }
            }
            Destroy(baked);
            for (int i = 0; i < proxies.Length; i++)
            {
                var x = proxies[i];
                float r = x.minRadius;
                if (dists[i].Count > 20)
                {
                    dists[i].Sort();
                    r = Mathf.Max(r, dists[i][(int)(dists[i].Count * 0.99f)] + 0.015f);
                }
                x.size = Mathf.Min(r, maxRadius);
            }
            UpdateClothProxies();
            var torso = System.Array.Find(proxies, x => x.c.name == "Cloth Torso");
            return Mathf.Max(torso.A.y, torso.B.y) + torso.c.radius;
        }

        float clothFade = 1f, clothFadeTarget = 1f, clothFadeRate;

        /// <summary>
        /// grow the cloth capsules from nothing to their size (1) or shrink them away (0) over some seconds. Cloth
        /// that a capsule pushed aside follows it gradually; adding or removing a capsule at once makes it jump.
        /// </summary>
        public void FadeClothCapsules(float to, float seconds)
        {
            clothFadeTarget = Mathf.Clamp01(to);
            if (seconds <= 0f) clothFade = clothFadeTarget;
            clothFadeRate = 1f / Mathf.Max(seconds, 0.01f);
        }

        /// <summary>
        /// take one arm out of the cloth's way (false) or back (true): a hand reaching for the quilt from under it slips
        /// out past its edge instead of pushing the quilt up in a jump
        /// </summary>
        public void ClothArm(AvatarIKGoal hand, bool on)
        {
            var name = hand == AvatarIKGoal.LeftHand ? "Cloth Left Arm" : "Cloth Right Arm";
            foreach (var x in proxies) if (x.c.name == name) x.fadeTarget = on ? 1f : 0f;
        }

        /// <summary>back to the small sizes (standing up)</summary>
        public void UnfitClothCapsules()
        {
            foreach (var x in proxies) x.size = x.minRadius;
        }

        /// <summary>blend into a body state over <paramref name="seconds"/></summary>
        public void Play(string next, float seconds = 0.4f)
        {
            if (next == state) return;
            state = next;
            anim.CrossFadeInFixedTime(next, seconds, 0);
        }

        /// <summary>switch to a body state at once, from its start (when its first pose is the pose the body is in)</summary>
        public void PlayNow(string next)
        {
            state = next;
            anim.Play(next, 0, 0f);
        }

        /// <summary>how long a clip of the controller plays (s)</summary>
        public float ClipSeconds(string clip)
        {
            foreach (var c in anim.runtimeAnimatorController.animationClips)
                if (c.name == clip) return c.length;
            return 2f;
        }

        /// <summary>play the bed clips mirrored (they are made for the room on the left of someone lying in the bed)</summary>
        public void SetMirror(bool on) => anim.SetBool("Mirror", on);

        // ------------------------------------------------------------------ resting on a mattress

        ArmClearance armClearance;
        float armsClear;
        Transform surface;
        Vector2 surfaceHalf;
        float surfaceTop, lift, nextFit;
        List<(SkinnedMeshRenderer smr, bool[] skip, bool[] onHead)> fitMeshes;
        Mesh fitMesh;

        /// <summary>
        /// while on a bed: every twentieth of a second the body's lowest point over the mattress (hair left out) is found,
        /// and the whole model is raised or lowered so it rests on the surface. Poses and avatars differ (a thick
        /// skirt, a round back), so a fixed hips height either sinks into the mattress or floats over it.
        /// </summary>
        public void FitOnto(Transform bed, Vector2 halfSize, float topY)
        {
            surface = bed;
            surfaceHalf = halfSize;
            surfaceTop = topY;
            nextFit = 0;
            pillow = null;
            foreach (var r in bed.GetComponentsInChildren<Renderer>())
                if (r.name.Contains("Pillow") && Vector3.Distance(r.bounds.center, bed.position) < 1.5f) { pillow = r.bounds; break; }
            armClearance.SetSurface(bed, halfSize, topY);
            HairOnSurface(true);
        }

        public void FitOff()
        {
            surface = null;
            lift = 0;
            armClearance.SetSurface(null, default, 0f);
            HairOnSurface(false);
        }

        VRM10SpringBoneColliderGroup surfaceGroup;
        bool springsReady, hairOnSurface;
        /// <summary>how far over the mattress the hair's plane is (m): the hair is thicker than its chain of joints</summary>
        const float HairOverSurface = 0.03f;
        /// <summary>where the hair's plane and pillow wait while no bed is in use: far below the floor</summary>
        const float PlaneAway = -100f;
        /// <summary>
        /// the plane comes up from this far under the mattress's top, this fast (m, m/s), once the body is on the bed.
        /// Put straight at the top while standing beside the bed, it threw a coat's hem up 40 cm in one frame.
        /// </summary>
        const float PlaneRiseFrom = 0.25f, PlaneRise = 0.6f;
        float planeY = PlaneAway;
        /// <summary>the pillow, for the hair: capsules side by side across the bed, over its top</summary>
        readonly List<Transform> pillowCapsules = new();
        const int PillowCapsules = 3;
        Bounds? pillow;

        /// <summary>
        /// once, before anything moves: every spring (hair, skirt, hood) collides with a plane that lies on the mattress's
        /// top while on a bed, and simulates in world space.
        /// Rebuilding the springs later throws away where they are (UniVRM keeps their state in the buffer it replaces),
        /// so adding the plane on getting into bed flung the hair 20 to 65 cm in one frame. And VRoid simulates each
        /// spring relative to the model's root: the bed clips turn the root 90 degrees at once under a still body, and
        /// the hair swung as if the body had turned.
        /// </summary>
        void SetUpSprings()
        {
            if (!vrm || vrm.SpringBone == null || vrm.Runtime?.SpringBone == null)
            {
                springsReady = true;
                return;
            }
            if (!surfaceGroup)
            {
                var go = new GameObject("Mattress Plane (hair)");
                go.transform.SetParent(transform, false);
                var c = go.AddComponent<VRM10SpringBoneCollider>();
                c.ColliderType = VRM10SpringBoneColliderTypes.Plane;
                c.Normal = Vector3.up;
                surfaceGroup = go.AddComponent<VRM10SpringBoneColliderGroup>();
                surfaceGroup.Name = "mattress";
                surfaceGroup.Colliders.Add(c);
                for (int i = 0; i < PillowCapsules; i++)
                {
                    var p = new GameObject($"Pillow Capsule {i} (hair)");
                    p.transform.SetParent(go.transform, false);
                    var pc = p.AddComponent<VRM10SpringBoneCollider>();
                    pc.ColliderType = VRM10SpringBoneColliderTypes.Capsule;
                    surfaceGroup.Colliders.Add(pc);
                    pillowCapsules.Add(p.transform);
                }
                PlaceSurfacePlane();
            }
            foreach (var spring in vrm.SpringBone.Springs)
            {
                spring.Center = null;
                if (!spring.ColliderGroups.Contains(surfaceGroup)) spring.ColliderGroups.Add(surfaceGroup);
            }
            // while UniVRM still builds the springs it first made, a rebuild is refused: try again next frame
            springsReady = vrm.Runtime.SpringBone.ReconstructSpringBone();
            if (springsReady) Debug.Log($"[AvatarRig] {name}: {vrm.SpringBone.Springs.Count} springs in world space, with the bed's plane");
        }

        /// <summary>the hair's spring bones collide with the body only, so long hair fell through the mattress</summary>
        void HairOnSurface(bool on)
        {
            hairOnSurface = on;
            PlaceSurfacePlane();
        }

        void PlaceSurfacePlane()
        {
            if (!surfaceGroup) return;
            bool on = hairOnSurface && (Lying || OnBedMoving);
            if (!on) planeY = PlaneAway;
            else if (planeY < surfaceTop - PlaneRiseFrom) planeY = surfaceTop - PlaneRiseFrom;
            else planeY = Mathf.MoveTowards(planeY, surfaceTop + HairOverSurface, PlaneRise * Time.deltaTime);
            surfaceGroup.transform.SetPositionAndRotation(new Vector3(transform.position.x, planeY, transform.position.z), Quaternion.identity);
            // the pillow's capsules lie over its top, across the bed, and come up with the plane
            for (int i = 0; i < pillowCapsules.Count; i++)
            {
                var c = pillowCapsules[i].GetComponent<VRM10SpringBoneCollider>();
                if (!on || !pillow.HasValue || !surface)
                {
                    pillowCapsules[i].position = new Vector3(transform.position.x, PlaneAway, transform.position.z);
                    c.Offset = c.Tail = Vector3.zero;
                    continue;
                }
                var b = pillow.Value;
                float radius = b.extents.y;
                var across = surface.right;
                var along = surface.forward;
                float alongHalf = Mathf.Abs(Vector3.Dot(b.extents, new Vector3(Mathf.Abs(along.x), Mathf.Abs(along.y), Mathf.Abs(along.z))));
                float acrossHalf = Mathf.Abs(Vector3.Dot(b.extents, new Vector3(Mathf.Abs(across.x), Mathf.Abs(across.y), Mathf.Abs(across.z))));
                float k = PillowCapsules > 1 ? i / (PillowCapsules - 1f) * 2f - 1f : 0f;
                // as high as the plane has come up, at most the pillow's own place
                float rise = Mathf.Clamp01((planeY - (surfaceTop - PlaneRiseFrom)) / (PlaneRiseFrom + HairOverSurface));
                var centre = b.center + along * (k * (alongHalf - radius)) + Vector3.down * ((1f - rise) * (b.max.y - surfaceTop + PlaneRiseFrom));
                pillowCapsules[i].SetPositionAndRotation(centre, Quaternion.identity);
                c.Radius = radius;
                c.Offset = -across * (acrossHalf - radius);
                c.Tail = across * (acrossHalf - radius);
            }
        }

        void BuildFitMeshes()
        {
            fitMeshes = new List<(SkinnedMeshRenderer, bool[], bool[])>();
            fitMesh = new Mesh();
            var head = anim.GetBoneTransform(HumanBodyBones.Head);
            var leftArm = anim.GetBoneTransform(HumanBodyBones.LeftUpperArm);
            var rightArm = anim.GetBoneTransform(HumanBodyBones.RightUpperArm);
            var leftFoot = anim.GetBoneTransform(HumanBodyBones.LeftFoot);
            var rightFoot = anim.GetBoneTransform(HumanBodyBones.RightFoot);
            // (the arms keep themselves on the mattress, see ArmClearance: a hand on the bed must not lift the body. The
            // feet are lifted onto it by KeepFootOnBed: a thick shoe sole held the whole body 12 cm over the mattress)
            bool UnderHead(Transform t) { for (; t; t = t.parent) if (t == head || t == leftArm || t == rightArm || t == leftFoot || t == rightFoot) return true; return false; }
            bool IsHead(Transform t) { for (; t; t = t.parent) if (t == head) return true; return false; }
            foreach (var smr in GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                if (!smr.sharedMesh) continue;
                var bones = smr.bones;
                var weights = smr.sharedMesh.boneWeights;
                var skip = new bool[smr.sharedMesh.vertexCount];
                var onHead = new bool[skip.Length];
                // hair and anything else on the head lies where it falls; the body is what rests on the bed
                // (the head itself rests on what is under it: see RaiseHead)
                for (int i = 0; i < skip.Length && i < weights.Length; i++)
                {
                    int b = weights[i].boneIndex0;
                    skip[i] = b >= 0 && b < bones.Length && UnderHead(bones[b]);
                    onHead[i] = b >= 0 && b < bones.Length && IsHead(bones[b]);
                }
                fitMeshes.Add((smr, skip, onHead));
            }
        }

        /// <summary>how much to raise (or lower) the model so its lowest point over the mattress is on it</summary>
        float FitLift(float wantBase)
        {
            if (fitMeshes == null) BuildFitMeshes();
            // the mattress's top is rounded off along its edges (a 6 cm bevel): the surface drops toward them
            const float bevel = 0.06f;
            float SurfaceAt(Vector3 l)
            {
                float ex = Mathf.Max(0f, Mathf.Abs(l.x) - (surfaceHalf.x - bevel));
                float ez = Mathf.Max(0f, Mathf.Abs(l.z) - (surfaceHalf.y - bevel));
                float e = Mathf.Min(Mathf.Sqrt(ex * ex + ez * ez), bevel);
                return surfaceTop - (bevel - Mathf.Sqrt(bevel * bevel - e * e));
            }
            float need = float.MinValue;
            headNeed = 0f;
            var headAt = headBone ? headBone.position : hips.position;
            foreach (var (smr, skip, onHead) in fitMeshes)
            {
                if (!smr || !smr.enabled) continue;
                smr.BakeMesh(fitMesh, true);
                var m = Matrix4x4.TRS(smr.transform.position, smr.transform.rotation, Vector3.one);
                var verts = fitMesh.vertices;
                for (int v = 0; v < verts.Length; v += 2)
                {
                    if (v < skip.Length && skip[v])
                    {
                        // the back of the head and the hair on it (not long hair spread down the back)
                        if (!Lying || v >= onHead.Length || !onHead[v]) continue;
                        var h = m.MultiplyPoint3x4(verts[v]);
                        if ((h - headAt).sqrMagnitude > HeadReach * HeadReach) continue;
                        var hl = surface.InverseTransformPoint(h);
                        float under = pillow is Bounds pb && h.x > pb.min.x && h.x < pb.max.x && h.z > pb.min.z && h.z < pb.max.z
                            ? pb.max.y - PillowGive
                            : Mathf.Abs(hl.x) <= surfaceHalf.x && Mathf.Abs(hl.z) <= surfaceHalf.y ? SurfaceAt(hl) : float.MinValue;
                        headNeed = Mathf.Max(headNeed, under + 0.004f - h.y);
                        continue;
                    }
                    var w = m.MultiplyPoint3x4(verts[v]);
                    if (w.y > surfaceTop + 0.05f) continue;
                    var l = surface.InverseTransformPoint(w);
                    if (Mathf.Abs(l.x) > surfaceHalf.x || Mathf.Abs(l.z) > surfaceHalf.y) continue;
                    need = Mathf.Max(need, SurfaceAt(l) + 0.004f - w.y);
                }
            }
            if (need == float.MinValue) return lift;
            // where the model should be: where it is now, moved so its deepest point (or its lowest, if it floats) is on the surface
            float wantOffset = hipsOffset + need;
            return Mathf.Clamp(wantOffset - wantBase, -0.05f, 0.2f);
        }

        /// <summary>walking speed for the locomotion blend (m/s)</summary>
        public void SetSpeed(float metersPerSecond)
        {
            speedNow = metersPerSecond;
            anim.SetFloat("Speed", metersPerSecond, 0.15f, Time.deltaTime);
        }

        /// <summary>the body's live motion (see <see cref="LiveMotion"/>)</summary>
        public LiveMotion Live { get; private set; }
        /// <summary>standing still with nothing in hand, so live motion can drive the body</summary>
        public bool StandingFree => standingFor >= 0.6f;
        /// <summary>on the feet with nothing in hand (it may be walking)</summary>
        public bool FreeBody => freeBody;
        float speedNow, standingFor;
        bool freeBody, trackingClip;
        float liftEased, liftVelocity, entryOffset, entryVelocity;

        void OnDestroy() => Live?.Dispose();

        void UpdateStanding()
        {
            freeBody = state == Locomotion && !surface && !hipsTarget.HasValue && !feetAt.HasValue
                       && left.goal <= 0f && right.goal <= 0f && left.weight <= 0f && right.weight <= 0f;
            standingFor = freeBody && speedNow < 0.05f ? standingFor + Time.deltaTime : 0f;
        }

        /// <summary>hold the hips at this world height (on a seat or a mattress); null = let the clip decide</summary>
        public void HoldHipsAt(float? worldY) => hipsTarget = worldY;

        /// <summary>from the wrist to the fingertips (m)</summary>
        public float HandLength
        {
            get
            {
                var hand = anim.GetBoneTransform(HumanBodyBones.RightHand);
                var tip = anim.GetBoneTransform(HumanBodyBones.RightMiddleDistal);
                return hand && tip ? Vector3.Distance(hand.position, tip.position) : 0.15f;
            }
        }

        public void Reach(AvatarIKGoal hand, Transform target, Vector3 offset = default, Vector3? surfaceNormal = null, Vector3 surfacePoint = default)
        {
            var h = hand == AvatarIKGoal.LeftHand ? left : right;
            h.target = target;
            h.offset = offset;
            h.surfaceNormal = surfaceNormal;
            h.surfacePoint = surfacePoint;
            h.push = h.back = h.backGoal = 0f;
            h.goal = target ? 1f : 0f;
        }

        /// <summary>draw a hand straight back off the surface it is on, before <see cref="LetGo"/>: fading out from the handle swept the fingers through the door</summary>
        public void DrawBack(AvatarIKGoal hand, float meters) => (hand == AvatarIKGoal.LeftHand ? left : right).backGoal = meters;

        public void LetGo(AvatarIKGoal hand) => (hand == AvatarIKGoal.LeftHand ? left : right).goal = 0f;

        /// <summary>is the hand there yet (its IK fully blended in)?</summary>
        public bool HandArrived(AvatarIKGoal hand) => (hand == AvatarIKGoal.LeftHand ? left : right).weight > 0.95f;

        public void LookAt(Vector3? point) => lookAt = point;

        /// <summary>the thigh length (m): how far in front of the hips the knees are when sitting</summary>
        public float ThighLength => thighLength;

        /// <summary>
        /// plant both feet flat on the floor (world y = <paramref name="floorY"/>), side by side, a thigh's length in
        /// front of where the hips sit; the knees bend to suit. Null lets the clip place the feet again.
        /// </summary>
        /// <summary>keep the feet where they stand now (sitting down onto something behind): the knees bend as the hips go back</summary>
        public void PlantFeetHere(Vector3 forward, float floorY = 0f)
        {
            var lf = anim.GetBoneTransform(HumanBodyBones.LeftFoot);
            var rf = anim.GetBoneTransform(HumanBodyBones.RightFoot);
            if (!lf || !rf) return;
            var c = (lf.position + rf.position) * 0.5f;
            feetForward = new Vector3(forward.x, 0, forward.z).normalized;
            feetAt = new Vector3(c.x, floorY + ankleHeight, c.z);
            lastFeet = feetAt.Value;
            feetRate = FeetQuick;
        }

        public void PlantFeet(Vector3? hipsOnSeat, Vector3 forward = default, float floorY = 0f)
        {
            if (hipsOnSeat is Vector3 h)
            {
                feetForward = new Vector3(forward.x, 0, forward.z).normalized;
                var p = h + feetForward * (thighLength + 0.04f);
                feetAt = new Vector3(p.x, floorY + ankleHeight, p.z);
            }
            else feetAt = null;
        }

        /// <summary>plant both feet where they stood before (<see cref="ShoesAt"/>, say), side by side, toes forward</summary>
        public void PlantFeetAt(Vector3 feet, Vector3 forward)
        {
            feetForward = new Vector3(forward.x, 0, forward.z).normalized;
            feetAt = feet;
        }

        /// <summary>move one planted foot this far from its place (stepping out of a shoe, say). It goes back to its place once the feet are let go.</summary>
        public void ShiftFoot(bool left, Vector3 offset) => footShift[left ? 0 : 1] = offset;

        readonly Vector3[] footShift = new Vector3[2];

        // ------------------------------------------------------------------ shoes

        /// <summary>
        /// VRoid merges the shoes into the outfit, so a shoe is the outfit's triangles that are all skinned to one foot
        /// (its foot or toe bone). The body's own bare feet are under them.
        /// </summary>
        class ShoeParts
        {
            public SkinnedMeshRenderer smr;
            public Mesh worn;
            public int submesh;
            public int[] keep;
            public int[][] shoe;
        }

        ShoeParts shoes;
        bool shoesSearched;
        readonly GameObject[] droppedShoes = new GameObject[2];
        readonly bool[] shoeOff = new bool[2];

        /// <summary>where the planted feet were when the shoes came off: put them on again there</summary>
        public Vector3? ShoesAt { get; private set; }

        /// <summary>the outfit has shoes that can come off (one for each foot, apart from the body's own skin)</summary>
        public bool HasShoes
        {
            get
            {
                FindShoes();
                return shoes != null;
            }
        }

        void FindShoes()
        {
            if (shoesSearched) return;
            shoesSearched = true;
            var feet = new[]
            {
                new[] { anim.GetBoneTransform(HumanBodyBones.LeftFoot), anim.GetBoneTransform(HumanBodyBones.LeftToes) },
                new[] { anim.GetBoneTransform(HumanBodyBones.RightFoot), anim.GetBoneTransform(HumanBodyBones.RightToes) },
            };
            foreach (var smr in GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                var mesh = smr.sharedMesh;
                if (!mesh || mesh.subMeshCount < 2) continue;
                var materials = smr.sharedMaterials;
                var weights = mesh.boneWeights;
                var bones = smr.bones;
                int Side(int v)
                {
                    int b = weights[v].boneIndex0;
                    if (b < 0 || b >= bones.Length || !bones[b]) return -1;
                    return System.Array.IndexOf(feet[0], bones[b]) >= 0 ? 0 : System.Array.IndexOf(feet[1], bones[b]) >= 0 ? 1 : -1;
                }
                for (int s = 0; s < mesh.subMeshCount; s++)
                {
                    // the body's own skin stays: the bare feet are in it
                    if (s >= materials.Length || !materials[s] || materials[s].name.Contains("SKIN")) continue;
                    var tris = mesh.GetTriangles(s);
                    var keep = new List<int>();
                    var shoe = new[] { new List<int>(), new List<int>() };
                    for (int i = 0; i < tris.Length; i += 3)
                    {
                        int a = Side(tris[i]);
                        var to = a >= 0 && a == Side(tris[i + 1]) && a == Side(tris[i + 2]) ? shoe[a] : keep;
                        to.Add(tris[i]);
                        to.Add(tris[i + 1]);
                        to.Add(tris[i + 2]);
                    }
                    if (shoe[0].Count == 0 || shoe[1].Count == 0) continue;
                    shoes = new ShoeParts { smr = smr, submesh = s, keep = keep.ToArray(), shoe = new[] { shoe[0].ToArray(), shoe[1].ToArray() } };
                    Debug.Log($"[AvatarRig] {name}: shoes in {smr.name} ({materials[s].name}), {shoe[0].Count / 3} and {shoe[1].Count / 3} triangles");
                    return;
                }
            }
            Debug.Log($"[AvatarRig] {name}: no shoes found that can come off");
        }

        /// <summary>a shoe comes off: a copy of it, as it is now, stays where it stands, and the body's one is hidden</summary>
        public void DropShoe(bool left)
        {
            FindShoes();
            int s = left ? 0 : 1;
            if (shoes == null || shoeOff[s]) return;
            if (!ShoesAt.HasValue) ShoesAt = feetAt ?? lastFeet;
            var baked = new Mesh();
            shoes.smr.BakeMesh(baked, true);
            var verts = baked.vertices;
            var normals = baked.normals;
            var uv = baked.uv;
            var map = new Dictionary<int, int>();
            var nv = new List<Vector3>();
            var nn = new List<Vector3>();
            var nu = new List<Vector2>();
            var nt = new List<int>();
            foreach (var v in shoes.shoe[s])
            {
                if (!map.TryGetValue(v, out int j))
                {
                    j = nv.Count;
                    map[v] = j;
                    nv.Add(verts[v]);
                    nn.Add(normals[v]);
                    nu.Add(uv[v]);
                }
                nt.Add(j);
            }
            Destroy(baked);
            var mesh = new Mesh { name = left ? "Left Shoe" : "Right Shoe" };
            mesh.SetVertices(nv);
            mesh.SetNormals(nn);
            mesh.SetUVs(0, nu);
            mesh.SetTriangles(nt, 0);
            mesh.RecalculateBounds();
            // in the scene itself: under the character, the shoes turned with it when it swung its legs onto the bed,
            // into the bed's frame
            var go = new GameObject($"{name} {mesh.name}");
            go.transform.SetPositionAndRotation(shoes.smr.transform.position, shoes.smr.transform.rotation);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = shoes.smr.sharedMaterials[shoes.submesh];
            droppedShoes[s] = go;
            shoeOff[s] = true;
            UpdateWornShoes();
        }

        /// <summary>the foot is back in its shoe: the one on the floor goes, and the body's one shows again</summary>
        public void WearShoe(bool left)
        {
            int s = left ? 0 : 1;
            if (shoes == null || !shoeOff[s]) return;
            if (droppedShoes[s]) Destroy(droppedShoes[s]);
            droppedShoes[s] = null;
            shoeOff[s] = false;
            if (!shoeOff[0] && !shoeOff[1]) ShoesAt = null;
            UpdateWornShoes();
        }

        void UpdateWornShoes()
        {
            // the body's mesh becomes this avatar's own copy the first time a shoe comes off
            if (!shoes.worn)
            {
                shoes.worn = Instantiate(shoes.smr.sharedMesh);
                shoes.smr.sharedMesh = shoes.worn;
            }
            var tris = new List<int>(shoes.keep);
            for (int s = 0; s < 2; s++) if (!shoeOff[s]) tris.AddRange(shoes.shoe[s]);
            shoes.worn.SetTriangles(tris, shoes.submesh);
        }

        void Update()
        {
            BlendHand(left);
            BlendHand(right);
            feetWeight = Mathf.MoveTowards(feetWeight, feetAt.HasValue ? 1f : 0f, Time.deltaTime * feetRate);
            if (feetWeight >= 1f || feetWeight <= 0f) feetRate = FeetSlow;
            if (!feetAt.HasValue && feetWeight <= 0f) footShift[0] = footShift[1] = Vector3.zero;
            clothFade = Mathf.MoveTowards(clothFade, clothFadeTarget, Time.deltaTime * clothFadeRate);
            lookWeight = Mathf.MoveTowards(lookWeight, lookAt.HasValue ? 1f : 0f, Time.deltaTime * 1.5f);
            // the eyes and head follow one target that moves smoothly, also back to looking ahead (or up, lying down):
            // switching targets at once snapped the head round
            var rest = Lying && headBone ? headBone.position + Vector3.up * 2f : transform.position + transform.forward * 3f + Vector3.up * Height * 0.92f;
            eyeTarget.position = Vector3.Lerp(eyeTarget.position, lookAt ?? rest, 1f - Mathf.Exp(-Time.deltaTime * 5f));
            Blink();
        }

        static void BlendHand(HandIk h)
        {
            h.weight = Mathf.MoveTowards(h.weight, h.target ? h.goal : 0f, Time.deltaTime * 2.2f);
            h.back = Mathf.MoveTowards(h.back, h.backGoal, Time.deltaTime * 0.7f);
        }

        void OnAnimatorIK(int layer)
        {
            ApplyHand(AvatarIKGoal.LeftHand, left);
            ApplyHand(AvatarIKGoal.RightHand, right);
            ApplyFeet();
            var look = eyeTarget.position;
            anim.SetLookAtWeight(lookWeight * 0.8f, 0.2f, 0.7f, 1f, 0.6f);
            anim.SetLookAtPosition(look);
        }

        Vector3 lastFeet;

        void ApplyFeet()
        {
            if (feetAt.HasValue)
            {
                lastFeet = feetAt.Value;
                // short legs on a high seat do not reach the floor: then the feet hang, as low as the legs reach
                var hip = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
                if (hip)
                {
                    float reach = (thighLength + shinLength) * 0.97f;
                    var d = lastFeet - hip.position;
                    float flat = new Vector2(d.x, d.z).magnitude;
                    if (d.magnitude > reach && flat < reach) lastFeet.y = hip.position.y - Mathf.Sqrt(reach * reach - flat * flat);
                }
            }
            float w = Mathf.SmoothStep(0, 1, feetWeight);
            var right = Vector3.Cross(Vector3.up, feetForward);
            var rot = feetForward.sqrMagnitude > 0.5f ? Quaternion.LookRotation(feetForward, Vector3.up) : transform.rotation;
            foreach (var (goal, hint, side) in new[] { (AvatarIKGoal.LeftFoot, AvatarIKHint.LeftKnee, -1f), (AvatarIKGoal.RightFoot, AvatarIKHint.RightKnee, 1f) })
            {
                anim.SetIKPositionWeight(goal, w);
                anim.SetIKRotationWeight(goal, w);
                if (w <= 0f) { anim.SetIKHintPositionWeight(hint, 0); continue; }
                var foot = lastFeet + right * (side * hipWidth * 0.5f) + footShift[side < 0f ? 0 : 1];
                anim.SetIKPosition(goal, foot);
                anim.SetIKRotation(goal, rot);
                // the knees point forward over the feet
                anim.SetIKHintPosition(hint, foot + feetForward * 0.25f + Vector3.up * 0.35f);
                anim.SetIKHintPositionWeight(hint, w * 0.6f);
            }
        }

        float leftFootRise, rightFootRise;

        /// <summary>
        /// on a bed, a foot the clip puts under the mattress's top is lifted onto it: the leg is solved again after the
        /// Animator, from the hip, with the knee bending upward. It eases in over the last 8 cm outside the edge, so a
        /// foot coming in over the edge rises instead of jumping.
        /// </summary>
        void KeepFootOnBed(HumanBodyBones upperBone, HumanBodyBones lowerBone, HumanBodyBones footBone, ref float risen)
        {
            var upper = anim.GetBoneTransform(upperBone);
            var lower = anim.GetBoneTransform(lowerBone);
            var foot = anim.GetBoneTransform(footBone);
            if (!upper || !lower || !foot) return;
            var ankle = foot.position;
            var l = surface.InverseTransformPoint(ankle);
            float outside = Mathf.Max(Mathf.Abs(l.x) - surfaceHalf.x, Mathf.Abs(l.z) - surfaceHalf.y);
            float over = Mathf.SmoothStep(0f, 1f, 1f - outside / 0.08f);
            float want = Mathf.Max(0f, surfaceTop + ankleHeight * 0.9f - ankle.y) * over;
            risen = Mathf.Lerp(risen, want, 1f - Mathf.Exp(-25f * Time.deltaTime));
            if (risen < 0.0005f) return;

            var footRotation = foot.rotation;
            var hip = upper.position;
            var knee = lower.position;
            var target = ankle + Vector3.up * risen;
            float a = (knee - hip).magnitude, b = (ankle - knee).magnitude;
            var toTarget = target - hip;
            float d = Mathf.Clamp(toTarget.magnitude, Mathf.Abs(a - b) + 0.001f, a + b - 0.001f);
            var dir = toTarget.normalized;
            var pole = Vector3.ProjectOnPlane(knee - hip + Vector3.up * 0.1f, dir).normalized;
            float along = (a * a - b * b + d * d) / (2f * d);
            var newKnee = hip + dir * along + pole * Mathf.Sqrt(Mathf.Max(0f, a * a - along * along));
            upper.rotation = Quaternion.FromToRotation(knee - hip, newKnee - hip) * upper.rotation;
            lower.rotation = Quaternion.FromToRotation(foot.position - lower.position, hip + dir * d - lower.position) * lower.rotation;
            foot.rotation = footRotation;
        }

        /// <summary>
        /// a hand on a flat thing (a door) lies along it with the palm toward it. The IK only places the wrist, and fingers
        /// pointing at the surface went through it.
        /// </summary>
        void LayHandFlat(HandIk h, HumanBodyBones handBone, HumanBodyBones middle, HumanBodyBones index, HumanBodyBones little, float side)
        {
            if (!h.target || !h.surfaceNormal.HasValue || h.weight <= 0f) return;
            var hand = anim.GetBoneTransform(handBone);
            var mid = anim.GetBoneTransform(middle);
            var first = anim.GetBoneTransform(index);
            var last = anim.GetBoneTransform(little);
            if (!hand || !mid || !first || !last) return;
            float w = Mathf.SmoothStep(0f, 1f, h.weight);
            var normal = h.target.TransformDirection(h.surfaceNormal.Value).normalized;
            var fingers = (mid.position - hand.position).normalized;
            var along = Vector3.ProjectOnPlane(fingers, normal);
            if (along.sqrMagnitude < 1e-4f) return;
            hand.rotation = Quaternion.Slerp(Quaternion.identity, Quaternion.FromToRotation(fingers, along.normalized), w) * hand.rotation;
            fingers = (mid.position - hand.position).normalized;
            var palm = Vector3.Cross(fingers, first.position - last.position).normalized * side;
            var from = Vector3.ProjectOnPlane(palm, fingers);
            var to = Vector3.ProjectOnPlane(-normal, fingers);
            if (from.sqrMagnitude < 1e-4f || to.sqrMagnitude < 1e-4f) return;
            hand.rotation = Quaternion.Slerp(Quaternion.identity, Quaternion.FromToRotation(from.normalized, to.normalized), w) * hand.rotation;

            // the wrist backs off along the normal until the lowest fingertip is clear (it comes back when there is room)
            var face = h.target.TransformPoint(h.surfacePoint);
            float lowest = float.MaxValue;
            foreach (var (m, e) in side < 0f ? LeftFingers : RightFingers)
            {
                var a = anim.GetBoneTransform(m);
                var b = anim.GetBoneTransform(e);
                if (!a || !b) continue;
                var tip = b.position + (b.position - a.position) * 0.9f;
                lowest = Mathf.Min(lowest, Mathf.Min(Vector3.Dot(tip - face, normal), Vector3.Dot(b.position - face, normal)));
            }
            if (lowest < float.MaxValue) h.push = Mathf.Clamp(h.push + (FingerClear - lowest) * 0.5f, 0f, 0.12f);
        }

        void ApplyHand(AvatarIKGoal goal, HandIk h)
        {
            var elbow = goal == AvatarIKGoal.LeftHand ? AvatarIKHint.LeftElbow : AvatarIKHint.RightElbow;
            if (!h.target || h.weight <= 0f)
            {
                anim.SetIKPositionWeight(goal, 0);
                anim.SetIKRotationWeight(goal, 0);
                anim.SetIKHintPositionWeight(elbow, 0);
                return;
            }
            float w = Mathf.SmoothStep(0, 1, h.weight);
            var wrist = h.target.TransformPoint(h.offset);
            if (h.surfaceNormal.HasValue) wrist += h.target.TransformDirection(h.surfaceNormal.Value).normalized * (h.push + h.back);
            var shoulder = anim.GetBoneTransform(goal == AvatarIKGoal.LeftHand ? HumanBodyBones.LeftUpperArm : HumanBodyBones.RightUpperArm);
            if (surface)
            {
                // lying down, the quilt's edge rises out of reach as it turns over. A straight arm has no defined roll,
                // so it snapped 40 to 50 degrees the moment it locked: the hand stays just within reach instead
                var lowerArm = anim.GetBoneTransform(goal == AvatarIKGoal.LeftHand ? HumanBodyBones.LeftLowerArm : HumanBodyBones.RightLowerArm);
                var handBone = anim.GetBoneTransform(goal == AvatarIKGoal.LeftHand ? HumanBodyBones.LeftHand : HumanBodyBones.RightHand);
                float armLength = Vector3.Distance(shoulder.position, lowerArm.position) + Vector3.Distance(lowerArm.position, handBone.position);
                wrist = shoulder.position + Vector3.ClampMagnitude(wrist - shoulder.position, armLength * LyingReach);
            }
            anim.SetIKPosition(goal, wrist);
            anim.SetIKPositionWeight(goal, w);
            // palm toward the thing, fingers forward. On the bed, only the level part of that direction: the quilt's
            // edge rises above the shoulder as it turns over, the direction points almost straight up, the roll of a
            // rotation looking along it is undefined, and the forearm snapped 60 to 75 degrees in one frame. With no
            // rotation at all, the fingers kept the clip's and went 11 cm into the mattress.
            var dir = h.target.position - shoulder.position;
            if (surface)
            {
                var outward = goal == AvatarIKGoal.LeftHand ? -transform.right : transform.right;
                var level = Vector3.ProjectOnPlane(dir, Vector3.up);
                float share = dir.sqrMagnitude > 1e-6f ? level.magnitude / dir.magnitude : 0f;
                dir = Vector3.Slerp(outward, level.sqrMagnitude > 1e-6f ? level.normalized : outward, Mathf.InverseLerp(0.1f, 0.4f, share));
            }
            if (dir.sqrMagnitude > 1e-4f)
            {
                anim.SetIKRotation(goal, Quaternion.LookRotation(dir, Vector3.up));
                anim.SetIKRotationWeight(goal, w * 0.5f);
            }
            else anim.SetIKRotationWeight(goal, 0);
            if (surface)
            {
                // reaching from lying down, the elbow goes out from the shoulder and a little up, not down through the
                // mattress. The place is fixed to the body: one taken from the middle of the reach plus "up" lay almost
                // on the shoulder-to-hand line under the quilt's rising edge, and the elbow flipped over as it moved.
                var outward = goal == AvatarIKGoal.LeftHand ? -transform.right : transform.right;
                anim.SetIKHintPosition(elbow, shoulder.position + outward * 0.3f + Vector3.up * 0.15f);
                anim.SetIKHintPositionWeight(elbow, w * 0.7f);
            }
            else anim.SetIKHintPositionWeight(elbow, 0);
        }

        void LateUpdate()
        {
            if (!hips) return;
            if (!springsReady) SetUpSprings();
            UpdateStanding();
            Live.SetHand(true, left.target ? left.target.TransformPoint(left.offset) : Vector3.zero, left.target ? Mathf.SmoothStep(0f, 1f, left.weight) : 0f);
            Live.SetHand(false, right.target ? right.target.TransformPoint(right.offset) : Vector3.zero, right.target ? Mathf.SmoothStep(0f, 1f, right.weight) : 0f);
            Live.Apply(StandingFree, freeBody, Time.deltaTime);
            LayHandFlat(left, HumanBodyBones.LeftHand, HumanBodyBones.LeftMiddleProximal, HumanBodyBones.LeftIndexProximal, HumanBodyBones.LeftLittleProximal, -1f);
            LayHandFlat(right, HumanBodyBones.RightHand, HumanBodyBones.RightMiddleProximal, HumanBodyBones.RightIndexProximal, HumanBodyBones.RightLittleProximal, 1f);
            // the arms stay out of the body in every pose: the clips are made on one reference avatar, the outfits differ
            armsClear = Mathf.MoveTowards(armsClear, 1f, Time.deltaTime / 0.4f);
            if (armsClear > 0f) armClearance.Apply(Mathf.SmoothStep(0, 1, armsClear), left.weight, right.weight,
                state != Locomotion || left.goal > 0f || right.goal > 0f || left.weight > 0f || right.weight > 0f, Time.deltaTime);
            if (surface && !feetAt.HasValue && feetWeight <= 0f)
            {
                KeepFootOnBed(HumanBodyBones.LeftUpperLeg, HumanBodyBones.LeftLowerLeg, HumanBodyBones.LeftFoot, ref leftFootRise);
                KeepFootOnBed(HumanBodyBones.RightUpperLeg, HumanBodyBones.RightLowerLeg, HumanBodyBones.RightFoot, ref rightFootRise);
            }
            else leftFootRise = rightFootRise = 0f;
            float want = 0f, clipOffset = 0f;
            // (generated motion on a bed already has its height: the model only moves to rest it on the mattress)
            bool liveOnBed = surface && !hipsTarget.HasValue && Live.Walking && Live.Weight > 0f;
            if (hipsTarget.HasValue || liveOnBed)
            {
                // the model moves as a whole, so the hips end up exactly at the target
                float hipsNow = hips.position.y - hipsOffset;
                want = clipOffset = hipsTarget.HasValue ? hipsTarget.Value - hipsNow : 0f;
                if (surface)
                {
                    // (every frame while the body is changing pose on the bed, where a tenth of a second is a visible dip)
                    if (Time.time >= nextFit) { nextFit = Time.time + (OnBedMoving ? 0f : 0.05f); lift = FitLift(want); }
                    want += lift;
                }
            }
            // a critically damped spring: it starts and stops gently (an exponential ease jumped on the first frames)
            // (on a bed it follows the fitted height closely: lagging behind lets the body dip into the mattress)
            if (surface && (hipsTarget.HasValue || liveOnBed))
            {
                // the bed clips carry the hips at very different heights: blending two of them moved the wanted offset by
                // 80 cm in under a second, and easing after it threw the body 15 cm into the air. So the clip's height is
                // followed exactly, and only the fit to the mattress and the step onto the bed are eased.
                if (!trackingClip)
                {
                    trackingClip = true;
                    liftEased = lift;
                    liftVelocity = entryVelocity = 0f;
                    entryOffset = hipsOffset - (clipOffset + liftEased);
                }
                liftEased = Mathf.SmoothDamp(liftEased, lift, ref liftVelocity, lift > liftEased ? 0.05f : 0.3f, Mathf.Infinity, Time.deltaTime);
                entryOffset = Mathf.SmoothDamp(entryOffset, 0f, ref entryVelocity, 0.12f, Mathf.Infinity, Time.deltaTime);
                hipsOffset = clipOffset + liftEased + entryOffset;
                hipsVelocity = 0f;
            }
            else
            {
                trackingClip = false;
                hipsOffset = Mathf.SmoothDamp(hipsOffset, want, ref hipsVelocity, surface ? (want > hipsOffset ? 0.05f : 0.16f) : 0.28f, Mathf.Infinity, Time.deltaTime);
            }
            var p = transform.localPosition;
            p.y = hipsOffset;
            transform.localPosition = p;
            headLift = Mathf.SmoothDamp(headLift, surface && Lying ? headNeed : 0f, ref headLiftVelocity, 0.15f, Mathf.Infinity, Time.deltaTime);
            if (headLift > 0.001f) RaiseHead(headLift);
            if (surface) PlaceSurfacePlane();
            UpdateClothProxies();
        }

        /// <summary>
        /// lying down, the head rests on what is under it (the pillow, or the mattress): the chest, neck and head bend
        /// it up by this much (m). The body is fitted to the mattress with the head left out, and the back of the head
        /// and its hair were in the mattress, or in the pillow once the head lay on it.
        /// </summary>
        void RaiseHead(float amount)
        {
            var chest = anim.GetBoneTransform(HumanBodyBones.UpperChest) ?? anim.GetBoneTransform(HumanBodyBones.Chest);
            var neck = anim.GetBoneTransform(HumanBodyBones.Neck);
            if (!chest || !neck || !headBone) return;
            var axis = Vector3.Cross(headBone.position - chest.position, Vector3.up);
            if (axis.sqrMagnitude < 1e-6f) return;
            axis.Normalize();
            // how far the head rises for each radian, shared out: the chest turns most, the head least
            float lever = 0.5f * Vector3.Distance(chest.position, headBone.position) + 0.35f * Vector3.Distance(neck.position, headBone.position) + 0.15f * 0.08f;
            float angle = Mathf.Min(amount / lever * Mathf.Rad2Deg, MaxHeadRaise);
            var turn = Quaternion.AngleAxis(angle * 0.5f, axis);
            chest.rotation = turn * chest.rotation;
            // the arms hang from the chest: turned with it, the hands went 7 to 15 cm into the mattress, so the
            // shoulders turn back
            foreach (var s in new[] { HumanBodyBones.LeftShoulder, HumanBodyBones.RightShoulder })
            {
                var shoulder = anim.GetBoneTransform(s);
                if (shoulder) shoulder.rotation = Quaternion.Inverse(turn) * shoulder.rotation;
            }
            neck.rotation = Quaternion.AngleAxis(angle * 0.35f, axis) * neck.rotation;
            headBone.rotation = Quaternion.AngleAxis(angle * 0.15f, axis) * headBone.rotation;
        }

        float headNeed, headLift, headLiftVelocity;
        /// <summary>the head's part of the mesh: within this of the head bone (m); how far the head sinks into a pillow (m); the most it bends up (degrees)</summary>
        const float HeadReach = 0.16f, PillowGive = 0.025f, MaxHeadRaise = 40f;

        void Blink()
        {
            if (vrm == null || vrm.Runtime == null) return;
            nextBlink -= Time.deltaTime;
            if (nextBlink <= 0 && blinkT < 0) { blinkT = 0; nextBlink = Random.Range(2f, 6f); }
            float w = 0;
            if (blinkT >= 0)
            {
                blinkT += Time.deltaTime;
                w = blinkT < 0.07f ? blinkT / 0.07f : 1f - (blinkT - 0.07f) / 0.1f;
                if (blinkT > 0.17f) { blinkT = -1; w = 0; }
            }
            if (state == Lie && GetComponentInParent<Agent>()?.Asleep == true) w = 1;
            vrm.Runtime.Expression.SetWeight(ExpressionKey.Blink, Mathf.Clamp01(w));
        }

        /// <summary>capsules on the torso and legs, on a kinematic body: doors stop against them, cloth lies over them</summary>
        void BuildCapsules()
        {
            if (!TryGetComponent(out Rigidbody rb)) rb = gameObject.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            var list = new List<CapsuleCollider>();
            bool Seg(HumanBodyBones a, HumanBodyBones b, float r)
            {
                var ta = anim.GetBoneTransform(a);
                var tb = anim.GetBoneTransform(b);
                if (!ta || !tb) return false;
                var c = ta.gameObject.AddComponent<CapsuleCollider>();
                var local = ta.InverseTransformPoint(tb.position);
                c.direction = Mathf.Abs(local.x) > Mathf.Abs(local.y) ? (Mathf.Abs(local.x) > Mathf.Abs(local.z) ? 0 : 2)
                                                                      : (Mathf.Abs(local.y) > Mathf.Abs(local.z) ? 1 : 2);
                c.center = local * 0.5f;
                c.height = local.magnitude + r * 2f;
                c.radius = r;
                list.Add(c);
                return true;
            }
            // a foot without a toe bone: a capsule 12 cm forward from the ankle
            void Tip(HumanBodyBones a, float r)
            {
                var ta = anim.GetBoneTransform(a);
                if (!ta) return;
                var c = ta.gameObject.AddComponent<CapsuleCollider>();
                var local = ta.InverseTransformDirection(transform.forward) * 0.12f;
                c.direction = Mathf.Abs(local.x) > Mathf.Abs(local.y) ? (Mathf.Abs(local.x) > Mathf.Abs(local.z) ? 0 : 2)
                                                                      : (Mathf.Abs(local.y) > Mathf.Abs(local.z) ? 1 : 2);
                c.center = local * 0.5f;
                c.height = 0.12f + r * 2f;
                c.radius = r;
                list.Add(c);
            }
            float s = Height / 1.6f;
            Seg(HumanBodyBones.Hips, HumanBodyBones.Neck, 0.13f * s);
            // a little fuller than the body: the blanket is cloth whose triangles span ~6 cm, so it needs some margin
            Seg(HumanBodyBones.LeftUpperLeg, HumanBodyBones.LeftLowerLeg, 0.085f * s);
            Seg(HumanBodyBones.RightUpperLeg, HumanBodyBones.RightLowerLeg, 0.085f * s);
            Seg(HumanBodyBones.LeftLowerLeg, HumanBodyBones.LeftFoot, 0.07f * s);
            Seg(HumanBodyBones.RightLowerLeg, HumanBodyBones.RightFoot, 0.07f * s);
            // the feet stick up when lying on the back
            if (!Seg(HumanBodyBones.LeftFoot, HumanBodyBones.LeftToes, 0.065f * s)) Tip(HumanBodyBones.LeftFoot, 0.065f * s);
            if (!Seg(HumanBodyBones.RightFoot, HumanBodyBones.RightToes, 0.065f * s)) Tip(HumanBodyBones.RightFoot, 0.065f * s);
            BodyCapsules = list.ToArray();
        }
    }
}

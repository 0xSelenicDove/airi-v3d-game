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
    ///  * turns the head and the eyes toward what the character attends to, and blinks;
    ///  * lifts or lowers the whole model so the hips rest on the seat or the mattress, whatever the avatar's size;
    ///  * gives the body capsule colliders, so doors stop against it and the blanket lies over it.
    /// </summary>
    [RequireComponent(typeof(Animator))]
    public class AvatarRig : MonoBehaviour
    {
        public const string Locomotion = "Locomotion", Sit = "Sit", Type = "Type", Lie = "Lie", Eat = "Eat";

        Animator anim;
        Vrm10Instance vrm;
        Transform hips;
        float hipsOffset;
        float? hipsTarget;
        readonly HandIk left = new(), right = new();
        Vector3? lookAt;
        float lookWeight;
        Transform eyeTarget;
        float nextBlink = 2f, blinkT = -1f;
        string state = Locomotion;

        public Animator Animator => anim;
        public float Height { get; private set; } = 1.6f;
        public CapsuleCollider[] BodyCapsules { get; private set; } = new CapsuleCollider[0];
        /// <summary>
        /// fat capsules for cloth only (a blanket): round both legs, round the torso, and round each arm. Cloth collides
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
            public bool trimStart, trimEnd;   // pull that rounded end in by the radius, so it stops at the bone (chest, shoulder)
            public Vector3 A, B;   // the axis, last update
        }
        public string State => state;

        class HandIk
        {
            public Transform target;
            public Vector3 offset;
            public float weight, goal;
        }

        void Awake()
        {
            anim = GetComponent<Animator>();
            anim.applyRootMotion = false;
            anim.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            vrm = GetComponent<Vrm10Instance>();
            hips = anim.GetBoneTransform(HumanBodyBones.Hips);
            var head = anim.GetBoneTransform(HumanBodyBones.Head);
            if (head) Height = head.position.y - transform.position.y + 0.12f;
            eyeTarget = new GameObject("EyeTarget").transform;
            eyeTarget.SetParent(transform.parent, false);
            if (vrm)
            {
                vrm.LookAtTargetType = VRM10ObjectLookAt.LookAtTargetTypes.SpecifiedTransform;
                vrm.LookAtTarget = eyeTarget;
            }
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
                return new ClothProxy { c = c, a1 = a1, a2 = a2, b1 = b1, b2 = b2, extend = extend, minRadius = r, trimStart = trimStart, trimEnd = trimEnd };
            }
            proxies = new[]
            {
                Make("Cloth Legs", 0.15f * sc, HumanBodyBones.LeftUpperLeg, HumanBodyBones.RightUpperLeg, HumanBodyBones.LeftFoot, HumanBodyBones.RightFoot, 0.12f * sc),
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
                x.c.radius = Mathf.Min(r, maxRadius);
            }
            UpdateClothProxies();
            var torso = proxies[1];
            return Mathf.Max(torso.A.y, torso.B.y) + torso.c.radius;
        }

        /// <summary>back to the small sizes (standing up)</summary>
        public void UnfitClothCapsules()
        {
            foreach (var x in proxies) x.c.radius = x.minRadius;
        }

        /// <summary>blend into a body state over <paramref name="seconds"/></summary>
        public void Play(string next, float seconds = 0.4f)
        {
            if (next == state) return;
            state = next;
            anim.CrossFadeInFixedTime(next, seconds, 0);
        }

        /// <summary>walking speed for the locomotion blend (m/s)</summary>
        public void SetSpeed(float metersPerSecond) => anim.SetFloat("Speed", metersPerSecond, 0.15f, Time.deltaTime);

        /// <summary>hold the hips at this world height (on a seat or a mattress); null = let the clip decide</summary>
        public void HoldHipsAt(float? worldY) => hipsTarget = worldY;

        public void Reach(AvatarIKGoal hand, Transform target, Vector3 offset = default)
        {
            var h = hand == AvatarIKGoal.LeftHand ? left : right;
            h.target = target;
            h.offset = offset;
            h.goal = target ? 1f : 0f;
        }

        public void LetGo(AvatarIKGoal hand) => (hand == AvatarIKGoal.LeftHand ? left : right).goal = 0f;

        /// <summary>is the hand there yet (its IK fully blended in)?</summary>
        public bool HandArrived(AvatarIKGoal hand) => (hand == AvatarIKGoal.LeftHand ? left : right).weight > 0.95f;

        public void LookAt(Vector3? point) => lookAt = point;

        void Update()
        {
            BlendHand(left);
            BlendHand(right);
            lookWeight = Mathf.MoveTowards(lookWeight, lookAt.HasValue ? 1f : 0f, Time.deltaTime * 1.5f);
            if (lookAt.HasValue) eyeTarget.position = Vector3.Lerp(eyeTarget.position, lookAt.Value, Time.deltaTime * 6f);
            else eyeTarget.position = transform.position + transform.forward * 3f + Vector3.up * Height * 0.92f;
            Blink();
        }

        static void BlendHand(HandIk h) => h.weight = Mathf.MoveTowards(h.weight, h.target ? h.goal : 0f, Time.deltaTime * 2.2f);

        void OnAnimatorIK(int layer)
        {
            ApplyHand(AvatarIKGoal.LeftHand, left);
            ApplyHand(AvatarIKGoal.RightHand, right);
            var look = lookAt ?? eyeTarget.position;
            anim.SetLookAtWeight(lookWeight * 0.8f, 0.2f, 0.7f, 1f, 0.6f);
            anim.SetLookAtPosition(look);
        }

        void ApplyHand(AvatarIKGoal goal, HandIk h)
        {
            if (!h.target || h.weight <= 0f)
            {
                anim.SetIKPositionWeight(goal, 0);
                anim.SetIKRotationWeight(goal, 0);
                return;
            }
            float w = Mathf.SmoothStep(0, 1, h.weight);
            anim.SetIKPosition(goal, h.target.TransformPoint(h.offset));
            anim.SetIKPositionWeight(goal, w);
            // palm toward the thing, fingers forward
            var shoulder = anim.GetBoneTransform(goal == AvatarIKGoal.LeftHand ? HumanBodyBones.LeftUpperArm : HumanBodyBones.RightUpperArm);
            var dir = h.target.position - shoulder.position;
            if (dir.sqrMagnitude > 1e-4f)
            {
                anim.SetIKRotation(goal, Quaternion.LookRotation(dir, Vector3.up));
                anim.SetIKRotationWeight(goal, w * 0.5f);
            }
            anim.SetIKHintPositionWeight(goal == AvatarIKGoal.LeftHand ? AvatarIKHint.LeftElbow : AvatarIKHint.RightElbow, 0);
        }

        void LateUpdate()
        {
            if (!hips) return;
            float want = 0f;
            if (hipsTarget.HasValue)
            {
                // the model moves as a whole, so the hips end up exactly at the target
                float hipsNow = hips.position.y - hipsOffset;
                want = hipsTarget.Value - hipsNow;
            }
            hipsOffset = Mathf.Lerp(hipsOffset, want, 1f - Mathf.Exp(-Time.deltaTime * 6f));
            var p = transform.localPosition;
            p.y = hipsOffset;
            transform.localPosition = p;
            UpdateClothProxies();
        }

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

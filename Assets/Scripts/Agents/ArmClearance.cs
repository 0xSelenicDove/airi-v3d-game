using System.Collections.Generic;
using UnityEngine;

namespace AiWorld.Agents
{
    /// <summary>
    /// Keeps a character's arms outside her own body. The clips are made on one reference avatar, so on another figure
    /// or outfit a sleeve can sink into the ribs or a hand into the thigh. This measures the character's real torso,
    /// thighs and sleeves from her meshes (in the T-pose), and after the Animator has posed the arms it turns the upper
    /// arm and then the forearm just far enough to clear them, and to keep them on top of the mattress under them. The
    /// turn is eased, so an arm slides along the body and never snaps. Run it after the Animator and before anything
    /// that reads the final pose.
    /// </summary>
    public class ArmClearance
    {
        const int Bands = 6;
        /// <summary>how fast a correction grows and lets go (per second)</summary>
        const float Attack = 20f, Release = 7f;
        /// <summary>how far an elbow can swing out of the body while the hand is on something (degrees)</summary>
        const float MaxSwivel = 75f;
        /// <summary>
        /// the elbow's distance from the shoulder-to-wrist line (m): below the first the swing does nothing, and it is in
        /// full from the second. A point closer than <see cref="OnLine"/> to the line is not tested.
        /// </summary>
        const float StraightFrom = 0.02f, StraightTo = 0.06f, OnLine = 0.01f;
        /// <summary>
        /// off the bed, how far a free arm is turned out of the body (degrees). A loose jacket measures wide, and clearing
        /// all of it holds the arms out like a scarecrow: a sleeve brushing soft cloth looks far more natural.
        /// </summary>
        const float StandingPush = 10f;
        /// <summary>the same while using something, sitting or bending, where a squeezed arm shows more than a raised elbow</summary>
        const float BusyPush = 30f;
        /// <summary>how fast that limit changes (degrees per second), so an arm never pops when an activity starts</summary>
        const float PushChange = 60f;
        float pushLimit = StandingPush;

        class Arm
        {
            public Transform upper, lower, hand;
            public float side;              // -1 left, +1 right, along the torso's right
            public float upperRadius = 0.05f, lowerRadius = 0.045f, handRadius = 0.035f, handLength = 0.14f;
            public Quaternion upperFix = Quaternion.identity, lowerFix = Quaternion.identity;
            public float swivel;            // degrees the elbow is swung round the shoulder-to-wrist line
        }

        readonly Transform hips, neck, leftUpperLeg, rightUpperLeg, leftKnee, rightKnee;
        readonly Arm left, right;
        readonly float[] halfWidth = new float[Bands], halfDepth = new float[Bands];
        float torsoLength = 0.4f, thighRadius = 0.08f;
        readonly bool valid;
        Transform surface;
        Vector2 surfaceHalf;
        float surfaceTop;

        public ArmClearance(Animator anim, Transform root)
        {
            hips = anim.GetBoneTransform(HumanBodyBones.Hips);
            neck = anim.GetBoneTransform(HumanBodyBones.Neck);
            leftUpperLeg = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            rightUpperLeg = anim.GetBoneTransform(HumanBodyBones.RightUpperLeg);
            leftKnee = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg);
            rightKnee = anim.GetBoneTransform(HumanBodyBones.RightLowerLeg);
            left = MakeArm(anim, HumanBodyBones.LeftUpperArm, HumanBodyBones.LeftLowerArm, HumanBodyBones.LeftHand, HumanBodyBones.LeftMiddleDistal, -1f);
            right = MakeArm(anim, HumanBodyBones.RightUpperArm, HumanBodyBones.RightLowerArm, HumanBodyBones.RightHand, HumanBodyBones.RightMiddleDistal, 1f);
            valid = hips && neck && left != null && right != null && leftUpperLeg && rightUpperLeg && leftKnee && rightKnee;
            if (valid) Measure(anim, root);
        }

        static Arm MakeArm(Animator anim, HumanBodyBones u, HumanBodyBones l, HumanBodyBones h, HumanBodyBones tip, float side)
        {
            var upper = anim.GetBoneTransform(u);
            var lower = anim.GetBoneTransform(l);
            var hand = anim.GetBoneTransform(h);
            if (!upper || !lower || !hand) return null;
            var a = new Arm { upper = upper, lower = lower, hand = hand, side = side };
            var t = anim.GetBoneTransform(tip);
            if (t) a.handLength = Vector3.Distance(hand.position, t.position);
            return a;
        }

        // ------------------------------------------------------------------ measuring the outfit

        void Measure(Animator anim, Transform root)
        {
            const int Torso = 1, Thigh = 2, UpperArm = 3, LowerArm = 4, Hand = 5;
            var kind = new Dictionary<Transform, int>();
            void K(HumanBodyBones b, int v) { var t = anim.GetBoneTransform(b); if (t) kind[t] = v; }
            foreach (var b in new[] { HumanBodyBones.Hips, HumanBodyBones.Spine, HumanBodyBones.Chest, HumanBodyBones.UpperChest }) K(b, Torso);
            K(HumanBodyBones.LeftUpperLeg, Thigh); K(HumanBodyBones.RightUpperLeg, Thigh);
            K(HumanBodyBones.LeftUpperArm, UpperArm); K(HumanBodyBones.RightUpperArm, UpperArm);
            K(HumanBodyBones.LeftLowerArm, LowerArm); K(HumanBodyBones.RightLowerArm, LowerArm);
            K(HumanBodyBones.LeftHand, Hand); K(HumanBodyBones.RightHand, Hand);
            foreach (var b in new[] { HumanBodyBones.Neck, HumanBodyBones.LeftShoulder, HumanBodyBones.RightShoulder, HumanBodyBones.LeftLowerLeg, HumanBodyBones.RightLowerLeg }) K(b, 0);
            int KindOf(Transform t) { for (; t && t != root; t = t.parent) if (kind.TryGetValue(t, out var v)) return v; return 0; }

            var (o, r, u, f, _) = Frame();
            torsoLength = Mathf.Max(0.1f, Vector3.Distance(hips.position, neck.position));
            var widths = new List<float>[Bands];
            var depths = new List<float>[Bands];
            for (int i = 0; i < Bands; i++) { widths[i] = new List<float>(); depths[i] = new List<float>(); }
            var thigh = new List<float>();
            var upperArm = new List<float>();
            var lowerArm = new List<float>();
            var handR = new List<float>();
            var baked = new Mesh();
            foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>())
            {
                if (!smr.sharedMesh) continue;
                var bones = smr.bones;
                var weights = smr.sharedMesh.boneWeights;
                var kinds = new int[bones.Length];
                for (int i = 0; i < bones.Length; i++) kinds[i] = bones[i] ? KindOf(bones[i]) : 0;
                smr.BakeMesh(baked, true);
                var m = Matrix4x4.TRS(smr.transform.position, smr.transform.rotation, Vector3.one);
                var verts = baked.vertices;
                for (int v = 0; v < weights.Length && v < verts.Length; v += 2)
                {
                    int bi = weights[v].boneIndex0;
                    if (bi < 0 || bi >= kinds.Length || kinds[bi] == 0) continue;
                    var w = m.MultiplyPoint3x4(verts[v]);
                    switch (kinds[bi])
                    {
                        case Torso:
                            var d = w - o;
                            float t = Vector3.Dot(d, u) / torsoLength;
                            if (t < 0f || t >= 1f) break;
                            int band = (int)(t * Bands);
                            widths[band].Add(Mathf.Abs(Vector3.Dot(d, r)));
                            depths[band].Add(Mathf.Abs(Vector3.Dot(d, f)));
                            break;
                        case Thigh:
                            thigh.Add(Mathf.Min(DistanceToSegment(w, leftUpperLeg.position, leftKnee.position), DistanceToSegment(w, rightUpperLeg.position, rightKnee.position)));
                            break;
                        case UpperArm:
                            upperArm.Add(Mathf.Min(DistanceToSegment(w, left.upper.position, left.lower.position), DistanceToSegment(w, right.upper.position, right.lower.position)));
                            break;
                        case LowerArm:
                            lowerArm.Add(Mathf.Min(DistanceToSegment(w, left.lower.position, left.hand.position), DistanceToSegment(w, right.lower.position, right.hand.position)));
                            break;
                        case Hand:
                            handR.Add(Mathf.Min(DistanceToSegment(w, left.hand.position, left.hand.position + (left.hand.position - left.lower.position).normalized * left.handLength),
                                                DistanceToSegment(w, right.hand.position, right.hand.position + (right.hand.position - right.lower.position).normalized * right.handLength)));
                            break;
                    }
                }
            }
            Object.Destroy(baked);

            // the shoulders are where the arm starts: the torso never counts as wider than most of the way to them
            float maxWidth = Vector3.Distance(left.upper.position, right.upper.position) * 0.5f * 0.85f;
            for (int i = 0; i < Bands; i++)
            {
                halfWidth[i] = Mathf.Min(Percentile(widths[i], 0.9f, maxWidth * 0.75f), maxWidth);
                halfDepth[i] = Percentile(depths[i], 0.9f, maxWidth * 0.6f);
            }
            thighRadius = Percentile(thigh, 0.8f, 0.08f);
            foreach (var a in new[] { left, right })
            {
                a.upperRadius = Percentile(upperArm, 0.8f, a.upperRadius);
                a.lowerRadius = Percentile(lowerArm, 0.8f, a.lowerRadius);
                a.handRadius = Mathf.Min(Percentile(handR, 0.6f, a.handRadius), 0.05f);
            }
        }

        static float Percentile(List<float> xs, float q, float fallback)
        {
            if (xs.Count < 8) return fallback;
            xs.Sort();
            return xs[Mathf.Clamp((int)(xs.Count * q), 0, xs.Count - 1)];
        }

        static float DistanceToSegment(Vector3 p, Vector3 a, Vector3 b) => (p - Closest(p, a, b)).magnitude;

        static Vector3 Closest(Vector3 p, Vector3 a, Vector3 b)
        {
            var ab = b - a;
            float len = ab.sqrMagnitude;
            return len < 1e-8f ? a : a + ab * Mathf.Clamp01(Vector3.Dot(p - a, ab) / len);
        }

        /// <summary>the mattress the arms must stay on top of (half size in the bed's x and z), or null</summary>
        public void SetSurface(Transform bed, Vector2 halfSize, float topY)
        {
            surface = bed;
            surfaceHalf = halfSize;
            surfaceTop = topY;
        }

        // ------------------------------------------------------------------ each frame

        (Vector3 o, Vector3 r, Vector3 u, Vector3 f, Quaternion rot) Frame()
        {
            var o = hips.position;
            var u = (neck.position - o).normalized;
            var r = Vector3.ProjectOnPlane(right.upper.position - left.upper.position, u).normalized;
            var f = Vector3.Cross(r, u);
            return (o, r, u, f, Quaternion.LookRotation(f, u));
        }

        /// <summary>
        /// turn the arms clear of the body. <paramref name="amount"/> fades the whole thing (0..1). A hand under IK is
        /// on its way to something: <paramref name="leftIk"/> and <paramref name="rightIk"/> (0..1) leave it to the IK.
        /// </summary>
        public void Apply(float amount, float leftIk, float rightIk, bool busy, float dt)
        {
            if (!valid) return;
            pushLimit = Mathf.MoveTowards(pushLimit, busy ? BusyPush : StandingPush, PushChange * dt);
            Solve(left, amount * (1f - leftIk), dt);
            Solve(right, amount * (1f - rightIk), dt);
            Swivel(left, amount * leftIk, dt);
            Swivel(right, amount * rightIk, dt);
        }

        /// <summary>
        /// an arm reaching for something keeps its hand where the IK put it: the elbow swings round the line from shoulder
        /// to wrist, out of the body. The wrist is on that line, so it does not move.
        /// </summary>
        void Swivel(Arm a, float amount, float dt)
        {
            var s = a.upper.position;
            var e = a.lower.position;
            var w = a.hand.position;
            var axis = w - s;
            if (axis.sqrMagnitude < 1e-4f) return;
            axis.Normalize();
            float want = 0f;
            if (amount > 0f)
            {
                void Test(Vector3 p, float radius, bool thighs)
                {
                    var push = PushOut(p, radius, a.side, thighs);
                    if (push.sqrMagnitude < 1e-7f) return;
                    var centre = s + axis * Vector3.Dot(p - s, axis);
                    // a point on the line does not move when the arm turns about it
                    if ((p - centre).sqrMagnitude < OnLine * OnLine) return;
                    float angle = Vector3.SignedAngle(p - centre, Vector3.ProjectOnPlane(p + push - centre, axis), axis);
                    if (Mathf.Abs(angle) > Mathf.Abs(want)) want = angle;
                }
                Test(e, a.upperRadius, false);
                Test((s + e) * 0.5f, a.upperRadius, false);
                Test((e + w) * 0.5f, a.lowerRadius, true);
                // turning a nearly straight arm about the line only rolls it: the angle came from tiny offsets, swapped
                // sign from frame to frame, and twitched the arm 20 to 30 degrees while it reached for the quilt
                float bend = (e - (s + axis * Vector3.Dot(e - s, axis))).magnitude;
                want = Mathf.Clamp(want * 1.15f, -MaxSwivel, MaxSwivel) * Mathf.InverseLerp(StraightFrom, StraightTo, bend);
            }
            float rate = Mathf.Abs(want) > Mathf.Abs(a.swivel) ? Attack : Release;
            a.swivel = Mathf.Lerp(a.swivel, want, 1f - Mathf.Exp(-rate * dt));
            if (Mathf.Abs(a.swivel) < 0.01f) return;
            var hand = a.hand.rotation;
            a.upper.rotation = Quaternion.AngleAxis(a.swivel, axis) * a.upper.rotation;
            a.hand.rotation = hand;
        }

        void Solve(Arm a, float amount, float dt)
        {
            var (_, _, _, _, frame) = Frame();

            // the upper arm: the elbow and the middle of the arm (not next to the shoulder, which always touches)
            var s = a.upper.position;
            var e = a.lower.position;
            var want = Quaternion.identity;
            if (amount > 0f)
            {
                for (int pass = 0; pass < 2; pass++)
                {
                    var turned = want * (e - s);
                    float best = 0f;
                    var step = Quaternion.identity;
                    foreach (float t in new[] { 0.55f, 0.8f, 1f })
                    {
                        var p = s + turned * t;
                        var push = PushOut(p, a.upperRadius, a.side, false);
                        if (push.sqrMagnitude < 1e-7f) continue;
                        var q = Quaternion.FromToRotation(p - s, p + push - s);
                        q.ToAngleAxis(out float angle, out _);
                        if (angle > best) { best = angle; step = q; }
                    }
                    want = step * want;
                }
            }
            if (!surface) want = Quaternion.RotateTowards(Quaternion.identity, want, pushLimit);
            a.upperFix = Ease(a.upperFix, Quaternion.Inverse(frame) * want * frame, dt);
            a.upper.rotation = frame * Quaternion.Slerp(Quaternion.identity, a.upperFix, amount) * Quaternion.Inverse(frame) * a.upper.rotation;

            // then the forearm and the hand, from where the elbow is now
            e = a.lower.position;
            var w = a.hand.position;
            var along = (w - e).normalized;
            want = Quaternion.identity;
            if (amount > 0f)
            {
                float reach = (w - e).magnitude;
                for (int pass = 0; pass < 2; pass++)
                {
                    var dir = want * along;
                    float best = 0f;
                    var step = Quaternion.identity;
                    void Test(float dist, float radius)
                    {
                        var p = e + dir * dist;
                        var push = PushOut(p, radius, a.side, true);
                        if (push.sqrMagnitude < 1e-7f) return;
                        var q = Quaternion.FromToRotation(p - e, p + push - e);
                        q.ToAngleAxis(out float angle, out _);
                        if (angle > best) { best = angle; step = q; }
                    }
                    Test(reach * 0.5f, a.lowerRadius);
                    Test(reach, a.lowerRadius);
                    Test(reach + a.handLength * 0.5f, a.handRadius);
                    Test(reach + a.handLength, a.handRadius);
                    want = step * want;
                }
            }
            if (!surface) want = Quaternion.RotateTowards(Quaternion.identity, want, pushLimit);
            a.lowerFix = Ease(a.lowerFix, Quaternion.Inverse(frame) * want * frame, dt);
            a.lower.rotation = frame * Quaternion.Slerp(Quaternion.identity, a.lowerFix, amount) * Quaternion.Inverse(frame) * a.lower.rotation;
        }

        static Quaternion Ease(Quaternion now, Quaternion target, float dt)
        {
            float growing = Quaternion.Angle(target, Quaternion.identity) > Quaternion.Angle(now, Quaternion.identity) ? Attack : Release;
            return Quaternion.Slerp(now, target, 1f - Mathf.Exp(-growing * dt));
        }

        /// <summary>how far this point of an arm (a ball of this radius) must move to be outside the torso and thighs</summary>
        Vector3 PushOut(Vector3 p, float radius, float side, bool thighs)
        {
            var (o, r, u, f, _) = Frame();
            var d = p - o;
            float y = Vector3.Dot(d, u) / torsoLength;
            var push = Vector3.zero;
            if (y > -0.12f && y < 1.02f)
            {
                float band = Mathf.Clamp(y * Bands - 0.5f, 0f, Bands - 1.001f);
                int i = (int)band;
                float k = band - i;
                float rx = Mathf.Lerp(halfWidth[i], halfWidth[Mathf.Min(i + 1, Bands - 1)], k) + radius;
                float rz = Mathf.Lerp(halfDepth[i], halfDepth[Mathf.Min(i + 1, Bands - 1)], k) + radius;
                float x = Vector3.Dot(d, r), z = Vector3.Dot(d, f);
                float e = Mathf.Sqrt(x * x / (rx * rx) + z * z / (rz * rz));
                if (e < 1f)
                {
                    // out along the way it is already off the middle; an arm never goes through to the other side
                    float nx = x * side < 0f ? 0f : x, nz = z;
                    if (Mathf.Abs(nx) < 1e-3f && Mathf.Abs(nz) < 1e-3f) nx = side * rx;
                    float ne = Mathf.Sqrt(nx * nx / (rx * rx) + nz * nz / (rz * rz));
                    push = r * (nx / ne * 1.01f - x) + f * (nz / ne * 1.01f - z);
                }
            }
            if (thighs)
            {
                foreach (var (a, b) in new[] { (leftUpperLeg.position, leftKnee.position), (rightUpperLeg.position, rightKnee.position) })
                {
                    var c = Closest(p + push, a, b);
                    var away = p + push - c;
                    float dist = away.magnitude, need = thighRadius + radius;
                    if (dist >= need) continue;
                    push += (dist > 1e-4f ? away / dist : f) * (need - dist);
                }
            }
            if (surface)
            {
                var q = p + push;
                var l = surface.InverseTransformPoint(q);
                // (the forearm and hand get a little more: the curled fingers reach below the line of the hand)
                float clear = radius + (thighs ? 0.03f : 0f);
                if (Mathf.Abs(l.x) < surfaceHalf.x && Mathf.Abs(l.z) < surfaceHalf.y && q.y < surfaceTop + clear)
                    push.y += surfaceTop + clear - q.y;
            }
            return push;
        }
    }
}

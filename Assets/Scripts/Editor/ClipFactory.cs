using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;

namespace AiWorld.EditorTools
{
    /// <summary>
    /// Makes the humanoid clips and the Animator Controller the characters use.
    ///
    /// Clips are made from humanoid muscle values, so they play on every VRM. They are placeholders for motion
    /// capture: put a humanoid clip (an .fbx set to Humanoid, or an .anim) named Idle, Walk, Sit, Type, Lie, Eat, SitLean, BedSit or Stoop in
    /// Assets/Animations/Mocap and the controller uses it instead (run AiWorld ▸ Build Animator again).
    ///
    /// Which way a muscle moves (is +1 "thigh forward" or "thigh back"?) is measured on a real avatar here instead of
    /// assumed, so the poses come out right with any Unity version.
    /// </summary>
    public static class ClipFactory
    {
        const string Dir = "Assets/Animations";
        const string MocapDir = Dir + "/Mocap";
        const string GenDir = Dir + "/Generated";
        public const string ControllerPath = Dir + "/Character.controller";
        const string ReferenceAvatar = "Assets/Avatars/seed-san.vrm";

        static Dictionary<string, int> index;
        static float[] rest;
        static Vector3 restBody;
        static Dictionary<string, float> sign;

        [MenuItem("AiWorld/Build Animator")]
        public static AnimatorController Build()
        {
            Directory.CreateDirectory(GenDir);
            Directory.CreateDirectory(MocapDir);
            Measure();
            var clips = new Dictionary<string, Motion>
            {
                ["Idle"] = Pick("Idle", MakeIdle),
                ["Walk"] = Pick("Walk", MakeWalk),
                ["Sit"] = Pick("Sit", MakeSit),
                ["Type"] = Pick("Type", MakeType),
                ["Lie"] = Pick("Lie", MakeLie),
                ["Eat"] = Pick("Eat", MakeEat),
                ["SitLean"] = Pick("SitLean", MakeSitLean),
                ["BedSit"] = Pick("BedSit", MakeBedSit),
                ["Stoop"] = Pick("Stoop", MakeStoop),
                ["LieDown"] = Pick("LieDown", () => MakeLieDown(false)),
                ["SitUp"] = Pick("SitUp", () => MakeLieDown(true)),
            };

            AssetDatabase.DeleteAsset(ControllerPath);
            var ctrl = AnimatorController.CreateAnimatorControllerAtPath(ControllerPath);
            ctrl.AddParameter("Speed", AnimatorControllerParameterType.Float);
            var layers = ctrl.layers;
            layers[0].iKPass = true;
            ctrl.layers = layers;
            var sm = ctrl.layers[0].stateMachine;

            var loco = sm.AddState("Locomotion");
            var tree = new BlendTree { name = "Locomotion", blendParameter = "Speed", blendType = BlendTreeType.Simple1D, useAutomaticThresholds = false };
            AssetDatabase.AddObjectToAsset(tree, ctrl);
            tree.AddChild(clips["Idle"], 0f);
            tree.AddChild(clips["Walk"], 0.85f);
            loco.motion = tree;
            loco.iKOnFeet = false;
            sm.defaultState = loco;
            foreach (var name in new[] { "Sit", "Type", "Lie", "Eat", "SitLean", "BedSit", "Stoop", "LieDown", "SitUp" })
                sm.AddState(name).motion = clips[name];
            AssetDatabase.SaveAssets();
            Debug.Log($"[ClipFactory] wrote {ControllerPath}");
            return ctrl;
        }

        static Motion Pick(string name, Func<AnimationClip> make)
        {
            foreach (var guid in AssetDatabase.FindAssets(name, new[] { MocapDir }))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (Path.GetFileNameWithoutExtension(path) != name) continue;
                var clip = AssetDatabase.LoadAllAssetsAtPath(path).OfType<AnimationClip>().FirstOrDefault(c => !c.name.StartsWith("__preview__"));
                if (clip && clip.humanMotion)
                {
                    Debug.Log($"[ClipFactory] {name}: motion capture {path}");
                    return clip;
                }
            }
            var gen = make();
            gen.name = name;
            var p = $"{GenDir}/{name}.anim";
            AssetDatabase.DeleteAsset(p);
            AssetDatabase.CreateAsset(gen, p);
            return gen;
        }

        // ------------------------------------------------------------------ measuring the avatar

        static void Measure()
        {
            index = new Dictionary<string, int>();
            for (int i = 0; i < HumanTrait.MuscleCount; i++) index[HumanTrait.MuscleName[i]] = i;

            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(ReferenceAvatar);
            var go = (GameObject)UnityEngine.Object.Instantiate(prefab);
            try
            {
                go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
                var anim = go.GetComponent<Animator>();
                var handler = new HumanPoseHandler(anim.avatar, go.transform);
                var pose = new HumanPose();
                handler.GetHumanPose(ref pose);
                rest = (float[])pose.muscles.Clone();
                restBody = pose.bodyPosition;

                Vector3 P(HumanBodyBones b) => anim.GetBoneTransform(b).position;
                float Test(string muscle, Func<float> measure)
                {
                    var p = new HumanPose { bodyPosition = restBody, bodyRotation = Quaternion.identity, muscles = (float[])rest.Clone() };
                    p.muscles[index[muscle]] = rest[index[muscle]] + 0.3f;
                    handler.SetHumanPose(ref p);
                    float a = measure();
                    p.muscles[index[muscle]] = rest[index[muscle]] - 0.3f;
                    handler.SetHumanPose(ref p);
                    float b = measure();
                    return a > b ? 1f : -1f;
                }

                sign = new Dictionary<string, float>
                {
                    // +sign moves the thigh forward (knee toward +z)
                    ["UpperLegFwd"] = Test("Left Upper Leg Front-Back", () => P(HumanBodyBones.LeftLowerLeg).z),
                    // +sign bends the knee (foot toward -z, behind the knee) — measured with the thigh forward
                    ["KneeBend"] = TestKnee(handler, anim),
                    ["SpineFwd"] = Test("Spine Front-Back", () => P(HumanBodyBones.Head).z),
                    ["ChestFwd"] = Test("Chest Front-Back", () => P(HumanBodyBones.Head).z),
                    ["HeadDown"] = Test("Head Nod Down-Up", () => -anim.GetBoneTransform(HumanBodyBones.Head).forward.y - anim.GetBoneTransform(HumanBodyBones.Head).up.z * 0f),
                    ["ArmUp"] = Test("Left Arm Down-Up", () => P(HumanBodyBones.LeftHand).y),
                    ["ArmFwd"] = Test("Left Arm Front-Back", () => P(HumanBodyBones.LeftHand).z),
                    ["ElbowBend"] = Test("Left Forearm Stretch", () => -Vector3.Distance(P(HumanBodyBones.LeftHand), P(HumanBodyBones.LeftUpperArm))),
                    ["FootUp"] = Test("Left Foot Up-Down", () => P(HumanBodyBones.LeftToes).y),
                };
                sign["ShoulderUp"] = Test("Left Shoulder Down-Up", () => P(HumanBodyBones.LeftHand).y);
                armDown = SolveArmDown(handler, anim);
                thighLevel = SolveThighLevel(handler, anim);
                thighByTilt = SolveThighByTilt(handler, anim, 8);
                Debug.Log("[ClipFactory] muscle signs: " + string.Join(", ", sign.Select(kv => $"{kv.Key}={kv.Value:+0;-0}")));
                Debug.Log($"[ClipFactory] arms down: arm {armDown:0.00} with shoulder {ShoulderDown:0.00}; thighs level: {thighLevel:0.00}");
                Debug.Log($"[ClipFactory] rest body {restBody}");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        /// <summary>the shoulders a little down (relaxed), in muscle units</summary>
        const float ShoulderDown = -0.6f;
        /// <summary>the arm units (with <see cref="ShoulderDown"/>) that hang the upper arm about 8° out from the body</summary>
        static float armDown = -0.75f;

        /// <summary>
        /// The arm muscle ranges differ from avatar to avatar, and "-0.75" left the arms out in an A-pose. Find the
        /// units that hang the upper arm down beside the body instead.
        /// </summary>
        static float SolveArmDown(HumanPoseHandler handler, Animator anim)
        {
            var up = anim.GetBoneTransform(HumanBodyBones.LeftUpperArm);
            var low = anim.GetBoneTransform(HumanBodyBones.LeftLowerArm);
            float best = -0.75f, bestErr = float.MaxValue;
            for (float u = 0f; u >= -2f; u -= 0.025f)
            {
                var p = new HumanPose { bodyPosition = restBody, bodyRotation = Quaternion.identity, muscles = (float[])rest.Clone() };
                int s = index["Left Shoulder Down-Up"], a = index["Left Arm Down-Up"];
                p.muscles[s] = Mathf.Clamp(rest[s] + ShoulderDown * sign["ShoulderUp"], -1f, 1f);
                p.muscles[a] = Mathf.Clamp(rest[a] + u * sign["ArmUp"], -1f, 1f);
                handler.SetHumanPose(ref p);
                float angle = Vector3.Angle(low.position - up.position, Vector3.down);
                float err = Mathf.Abs(angle - 8f);
                if (err < bestErr - 0.01f) { bestErr = err; best = u; }
            }
            return best;
        }

        /// <summary>the thigh units that hold the thighs level (a hair above) when sitting up: "1.0" left them sloping down into the seat</summary>
        static float thighLevel = 1f;

        static float SolveThighLevel(HumanPoseHandler handler, Animator anim)
        {
            var up = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            var low = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg);
            float best = 1f, bestErr = float.MaxValue;
            for (float u = 0.5f; u <= 2.5f; u += 0.025f)
            {
                thighLevel = u;
                var p = Pose.LongSit();
                var hp = new HumanPose { bodyPosition = p.body, bodyRotation = p.rot, muscles = p.m };
                handler.SetHumanPose(ref hp);
                var d = (low.position - up.position).normalized;
                float elevation = Mathf.Asin(Mathf.Clamp(d.y, -1f, 1f)) * Mathf.Rad2Deg;
                float err = Mathf.Abs(elevation - 3f);
                if (err < bestErr - 0.01f) { bestErr = err; best = u; }
            }
            return best;
        }

        /// <summary>the thigh units that keep the thighs level at each step of lying back (0 = sitting up .. 1 = lying)</summary>
        static float[] thighByTilt = { 1f, 0.06f };

        static float[] SolveThighByTilt(HumanPoseHandler handler, Animator anim, int steps)
        {
            var up = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            var low = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg);
            var result = new float[steps + 1];
            var from = Pose.LongSit();
            var to = Pose.Lying();
            for (int i = 0; i <= steps; i++)
            {
                float k = i / (float)steps;
                float best = 0f, bestErr = float.MaxValue;
                for (float u = -0.5f; u <= 2.5f; u += 0.02f)
                {
                    var p = Pose.Lerp(from, to, k);
                    p.rot = Quaternion.AngleAxis(-90f * k, Vector3.right);
                    p.Thigh("Left", u).Thigh("Right", u);
                    var hp = new HumanPose { bodyPosition = p.body, bodyRotation = p.rot, muscles = p.m };
                    handler.SetHumanPose(ref hp);
                    var d = (low.position - up.position).normalized;
                    // level, a hair up, and pointing forward (not folded back)
                    float elevation = Mathf.Asin(Mathf.Clamp(d.y, -1f, 1f)) * Mathf.Rad2Deg;
                    float err = Mathf.Abs(elevation - 3f) + (d.z < 0 ? 180f : 0f);
                    if (err < bestErr - 0.01f) { bestErr = err; best = u; }
                }
                result[i] = best;
            }
            Debug.Log("[ClipFactory] thighs by tilt: " + string.Join(" ", result.Select(x => x.ToString("0.00"))));
            return result;
        }

        static float TestKnee(HumanPoseHandler handler, Animator anim)
        {
            float Foot(float delta)
            {
                var p = new HumanPose { bodyPosition = restBody, bodyRotation = Quaternion.identity, muscles = (float[])rest.Clone() };
                p.muscles[index["Left Lower Leg Stretch"]] = rest[index["Left Lower Leg Stretch"]] + delta;
                handler.SetHumanPose(ref p);
                var knee = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg).position;
                var foot = anim.GetBoneTransform(HumanBodyBones.LeftFoot).position;
                return foot.y - knee.y;   // a bent knee lifts the foot toward the knee
            }
            return Foot(+0.3f) > Foot(-0.3f) ? 1f : -1f;
        }

        // ------------------------------------------------------------------ poses

        /// <summary>a pose as offsets from the rest (T) pose, in muscle units, for named movements</summary>
        class Pose
        {
            public readonly float[] m = (float[])rest.Clone();
            public Vector3 body = restBody;
            public Quaternion rot = Quaternion.identity;

            public Pose Set(string muscle, float units) { m[index[muscle]] = Mathf.Clamp(rest[index[muscle]] + units, -1f, 1f); return this; }

            public Pose Both(string part, string move, float units)
            {
                Set($"Left {part} {move}", units);
                Set($"Right {part} {move}", units);
                return this;
            }

            public Pose Thigh(string side, float fwd) => Set($"{side} Upper Leg Front-Back", fwd * sign["UpperLegFwd"]);
            public Pose Knee(string side, float bend) => Set($"{side} Lower Leg Stretch", bend * sign["KneeBend"]);
            public Pose Foot(string side, float up) => Set($"{side} Foot Up-Down", up * sign["FootUp"]);
            /// <summary>the upper arm: <paramref name="up"/> = 0 hangs it down beside the body (see <see cref="SolveArmDown"/>)</summary>
            public Pose Arm(string side, float up, float fwd)
            {
                Set($"{side} Shoulder Down-Up", ShoulderDown * sign["ShoulderUp"]);
                Set($"{side} Arm Down-Up", (armDown + up) * sign["ArmUp"]);
                return Set($"{side} Arm Front-Back", fwd * sign["ArmFwd"]);
            }
            public Pose Elbow(string side, float bend) => Set($"{side} Forearm Stretch", bend * sign["ElbowBend"]);
            public Pose Spine(float fwd) { Set("Spine Front-Back", fwd * sign["SpineFwd"]); return Set("Chest Front-Back", fwd * 0.5f * sign["ChestFwd"]); }
            public Pose Head(float down) => Set("Head Nod Down-Up", down * sign["HeadDown"]);

            /// <summary>relaxed hands: fingers a little curled</summary>
            public Pose RelaxHands(float curl = 0.35f)
            {
                foreach (var side in new[] { "Left", "Right" })
                foreach (var f in new[] { "Index", "Middle", "Ring", "Little" })
                for (int j = 1; j <= 3; j++)
                    Set($"{side} {f} {j} Stretched", -curl * (j == 1 ? 0.7f : 1f));
                return this;
            }

            /// <summary>standing with the arms down by the sides</summary>
            public static Pose Standing()
            {
                var p = new Pose();
                p.Arm("Left", 0f, 0.06f).Arm("Right", 0f, 0.06f);
                p.Elbow("Left", 0.18f).Elbow("Right", 0.18f);
                p.Set("Left Forearm Twist In-Out", 0.25f).Set("Right Forearm Twist In-Out", 0.25f);
                p.RelaxHands();
                return p;
            }

            public static Pose Seated()
            {
                var p = Standing();
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, thighLevel).Knee(s, 1.0f).Foot(s, 0.1f);
                p.Spine(0.06f);
                // hands resting on the thighs
                p.Arm("Left", 0.2f, 0.35f).Arm("Right", 0.2f, 0.35f);
                p.Elbow("Left", 0.5f).Elbow("Right", 0.5f);
                return p;
            }

            /// <summary>on the back (the body turned 90° back), arms along the body, legs relaxed, the chin a little down on the pillow</summary>
            public static Pose Lying()
            {
                var p = Standing();
                p.Arm("Left", 0.06f, 0.08f).Elbow("Left", 0.3f);
                p.Arm("Right", 0.06f, 0.08f).Elbow("Right", 0.3f);
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, 0.06f).Knee(s, 0.12f).Foot(s, -0.35f);
                p.Set("Left Upper Leg Twist In-Out", -0.12f).Set("Right Upper Leg Twist In-Out", -0.12f);
                p.Spine(-0.02f);
                p.Head(0.2f);
                p.Set("Head Turn Left-Right", 0.06f);
                p.rot = Quaternion.AngleAxis(-90f, Vector3.right);
                return p;
            }

            /// <summary>between two poses: muscles and the body position blend, the body turns</summary>
            public static Pose Lerp(Pose a, Pose b, float t)
            {
                var p = new Pose();
                for (int i = 0; i < p.m.Length; i++) p.m[i] = Mathf.Lerp(a.m[i], b.m[i], t);
                p.body = Vector3.Lerp(a.body, b.body, t);
                p.rot = Quaternion.Slerp(a.rot, b.rot, t);
                return p;
            }

            /// <summary>sitting on a bed with the legs straight out on the mattress, the hands beside the hips</summary>
            public static Pose LongSit()
            {
                var p = Standing();
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, thighLevel).Knee(s, 0.06f).Foot(s, -0.25f);
                p.Spine(0.1f);
                p.Arm("Left", 0.12f, -0.12f).Arm("Right", 0.12f, -0.12f);
                p.Elbow("Left", 0.12f).Elbow("Right", 0.12f);
                p.Head(0.08f);
                return p;
            }
        }

        class Track
        {
            readonly List<(float t, Pose p)> keys = new();
            public Track Key(float t, Pose p) { keys.Add((t, p)); return this; }

            public AnimationClip Clip(bool loop)
            {
                var clip = new AnimationClip { frameRate = 30 };
                void Curve(string prop, Func<Pose, float> v)
                {
                    var c = new AnimationCurve(keys.Select(k => new Keyframe(k.t, v(k.p))).ToArray());
                    for (int i = 0; i < c.length; i++) c.SmoothTangents(i, 0);
                    AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), prop), c);
                }
                Curve("RootT.x", p => p.body.x);
                Curve("RootT.y", p => p.body.y);
                Curve("RootT.z", p => p.body.z);
                Curve("RootQ.x", p => p.rot.x);
                Curve("RootQ.y", p => p.rot.y);
                Curve("RootQ.z", p => p.rot.z);
                Curve("RootQ.w", p => p.rot.w);
                for (int i = 0; i < HumanTrait.MuscleCount; i++)
                {
                    int j = i;
                    Curve(ClipProperty(HumanTrait.MuscleName[i]), p => p.m[j]);
                }
                var s = AnimationUtility.GetAnimationClipSettings(clip);
                s.loopTime = loop;
                s.keepOriginalOrientation = true;
                s.keepOriginalPositionY = true;
                s.keepOriginalPositionXZ = true;
                s.loopBlendOrientation = true;
                s.loopBlendPositionY = true;
                s.loopBlendPositionXZ = true;
                AnimationUtility.SetAnimationClipSettings(clip, s);
                return clip;
            }
        }

        /// <summary>finger muscles are named "Left Index 1 Stretched" in HumanTrait but "LeftHand.Index.1 Stretched" in clips</summary>
        static string ClipProperty(string muscle)
        {
            foreach (var side in new[] { "Left", "Right" })
            foreach (var f in new[] { "Thumb", "Index", "Middle", "Ring", "Little" })
            {
                var prefix = $"{side} {f} ";
                if (!muscle.StartsWith(prefix)) continue;
                var rest_ = muscle.Substring(prefix.Length);           // "1 Stretched" or "Spread"
                var parts = rest_.Split(' ');
                return parts.Length == 2 ? $"{side}Hand.{f}.{parts[0]} {parts[1]}" : $"{side}Hand.{f}.{rest_}";
            }
            return muscle;
        }

        // ------------------------------------------------------------------ the clips

        static AnimationClip MakeIdle()
        {
            // a 6 s loop: breathing twice, the weight shifting from one foot to the other and back, and the head and
            // arms drifting a little, each on its own phase, so it never reads as a held pose
            const float T = 6f;
            const int N = 24;
            var t = new Track();
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                float breath = Mathf.Sin(ph * 2f), shift = Mathf.Sin(ph);
                var p = Pose.Standing();
                p.Spine(0.02f + 0.018f * breath);
                p.Set("Spine Left-Right", 0.04f * shift);
                p.Set("Chest Left-Right", -0.025f * shift);
                p.Set("Head Turn Left-Right", 0.07f * Mathf.Sin(ph + 1.1f));
                p.Set("Head Tilt Left-Right", 0.035f * Mathf.Sin(ph * 2f + 0.6f));
                p.Head(0.04f + 0.03f * Mathf.Sin(ph + 2.3f));
                // the leg without the weight relaxes its knee
                p.Knee("Left", 0.04f + 0.1f * Mathf.Max(0, -shift)).Knee("Right", 0.04f + 0.1f * Mathf.Max(0, shift));
                p.Arm("Left", 0.02f * breath, 0.06f + 0.03f * Mathf.Sin(ph + 0.4f)).Arm("Right", 0.02f * breath, 0.06f + 0.03f * Mathf.Sin(ph + 2.0f));
                p.Elbow("Left", 0.18f + 0.05f * Mathf.Sin(ph + 0.9f)).Elbow("Right", 0.18f + 0.05f * Mathf.Sin(ph + 2.6f));
                p.Set("Left Shoulder Down-Up", (ShoulderDown + 0.04f * breath) * sign["ShoulderUp"]);
                p.Set("Right Shoulder Down-Up", (ShoulderDown + 0.04f * breath) * sign["ShoulderUp"]);
                p.body = restBody + new Vector3(0.018f * shift, -0.006f + 0.003f * breath, 0);
                t.Key(i / (float)N * T, p);
            }
            return t.Clip(true);
        }

        static AnimationClip MakeWalk()
        {
            // one cycle = two steps, 1.1 s at 0.85 m/s
            const float T = 1.1f;
            var t = new Track();
            const int N = 16;
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                float s = Mathf.Sin(ph);
                var p = Pose.Standing();
                p.Thigh("Left", 0.32f * s).Thigh("Right", -0.32f * s);
                // the knee bends as the leg swings through (when its thigh moves forward)
                float swingL = Mathf.Max(0, Mathf.Cos(ph)), swingR = Mathf.Max(0, -Mathf.Cos(ph));
                p.Knee("Left", 0.08f + 0.55f * swingL).Knee("Right", 0.08f + 0.55f * swingR);
                p.Foot("Left", 0.15f * swingL).Foot("Right", 0.15f * swingR);
                // arms swing against the legs, close to the body
                p.Arm("Left", 0.04f, 0.06f - 0.24f * s).Arm("Right", 0.04f, 0.06f + 0.24f * s);
                p.Elbow("Left", 0.2f + 0.12f * Mathf.Max(0, -s)).Elbow("Right", 0.2f + 0.12f * Mathf.Max(0, s));
                p.Set("Spine Twist Left-Right", 0.06f * s);
                p.Set("Chest Twist Left-Right", -0.04f * s);
                p.Set("Spine Left-Right", 0.02f * s);
                p.Spine(0.035f);
                p.Head(0.03f - 0.015f * Mathf.Cos(ph * 2f));
                // the body is highest over the standing leg, twice a cycle
                p.body = restBody + new Vector3(0.012f * s, -0.012f + 0.012f * Mathf.Cos(ph * 2f), 0);
                t.Key(i / (float)N * T, p);
            }
            return t.Clip(true);
        }

        static AnimationClip MakeSit()
        {
            var t = new Track();
            const int N = 8;
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                var p = Pose.Seated();
                p.Spine(0.06f + 0.02f * Mathf.Sin(ph * 2f));
                p.Set("Head Turn Left-Right", 0.06f * Mathf.Sin(ph + 0.8f));
                p.Set("Head Tilt Left-Right", 0.03f * Mathf.Sin(ph + 2f));
                p.Head(0.06f + 0.03f * Mathf.Sin(ph));
                t.Key(i / (float)N * 6f, p);
            }
            return t.Clip(true);
        }

        /// <summary>sitting, leaning forward over the feet with the hands on the knees: the start of standing up</summary>
        static AnimationClip MakeSitLean()
        {
            var t = new Track();
            for (int i = 0; i <= 1; i++)
            {
                var p = Pose.Seated();
                foreach (var s in new[] { "Left", "Right" }) p.Knee(s, 1.15f);
                p.Spine(0.42f);
                p.Head(-0.05f);
                p.Arm("Left", 0.25f, 0.55f).Arm("Right", 0.25f, 0.55f);
                p.Elbow("Left", 0.2f).Elbow("Right", 0.2f);
                t.Key(i * 2f, p);
            }
            return t.Clip(true);
        }

        /// <summary>sitting on a bed with the legs out along it: between sitting on the edge and lying down</summary>
        static AnimationClip MakeBedSit()
        {
            var t = new Track();
            const int N = 6;
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                var p = Pose.LongSit();
                p.Spine(0.1f + 0.02f * Mathf.Sin(ph * 2f));
                p.Set("Head Turn Left-Right", 0.05f * Mathf.Sin(ph));
                t.Key(i / (float)N * 6f, p);
            }
            return t.Clip(true);
        }

        /// <summary>bending over a bed to take the blanket: back bent, knees soft, one arm free for the hand IK</summary>
        static AnimationClip MakeStoop()
        {
            var t = new Track();
            for (int i = 0; i <= 1; i++)
            {
                var p = Pose.Standing();
                p.Spine(0.55f);
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, 0.22f).Knee(s, 0.3f).Foot(s, 0.12f);
                p.Head(0.15f);
                p.Arm("Left", 0.1f, 0.3f).Arm("Right", 0.1f, 0.3f);
                p.Elbow("Left", 0.25f).Elbow("Right", 0.25f);
                p.body = restBody + new Vector3(0, -0.05f, -0.06f);
                t.Key(i * 2f, p);
            }
            return t.Clip(true);
        }

        static AnimationClip MakeType()
        {
            var t = new Track();
            const int N = 8;
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                var p = Pose.Seated();
                p.Spine(0.12f);
                p.Head(0.15f);
                // forearms forward over the keyboard, the hands tapping by turns
                p.Arm("Left", 0.25f, 0.55f).Arm("Right", 0.25f, 0.55f);
                p.Elbow("Left", 0.75f).Elbow("Right", 0.75f);
                p.Set("Left Hand Down-Up", 0.15f * Mathf.Max(0, Mathf.Sin(ph * 2f)) - 0.1f);
                p.Set("Right Hand Down-Up", 0.15f * Mathf.Max(0, -Mathf.Sin(ph * 2f + 0.7f)) - 0.1f);
                p.RelaxHands(0.25f);
                t.Key(i / (float)N * 1.6f, p);
            }
            return t.Clip(true);
        }

        static AnimationClip MakeLie()
        {
            // on the back, the head toward the character's back (the bed's head end), the chin a little down on the
            // pillow; the arms lie along the body, the elbows soft, the legs relaxed; slow breathing
            var t = new Track();
            const int N = 4;
            for (int i = 0; i <= N; i++)
            {
                float ph = i / (float)N * Mathf.PI * 2f;
                var p = Pose.Lying();
                p.Spine(-0.02f + 0.025f * Mathf.Sin(ph));
                t.Key(i / (float)N * 5f, p);
            }
            return t.Clip(true);
        }

        /// <summary>
        /// from sitting with the legs out along the bed to lying on the back (or back up, reversed). A cross-fade between
        /// the two would let the legs sag into the mattress half way (the thigh muscle does not move in step with the
        /// body's turn), so each key holds the thighs level for the tilt it is at (see <see cref="SolveThighLevel"/>).
        /// </summary>
        static AnimationClip MakeLieDown(bool reverse)
        {
            const float T = 1.6f;
            var t = new Track();
            var from = Pose.LongSit();
            var to = Pose.Lying();
            int n = thighByTilt.Length - 1;
            for (int i = 0; i <= n; i++)
            {
                float k = i / (float)n;
                var p = Pose.Lerp(from, to, k);
                p.rot = Quaternion.AngleAxis(-90f * k, Vector3.right);
                foreach (var side in new[] { "Left", "Right" }) p.Thigh(side, thighByTilt[i]);
                float time = (reverse ? 1f - k : k) * T;
                t.Key(time, p);
            }
            return t.Clip(false);
        }

        static AnimationClip MakeEat()
        {
            // the right hand brings food to the mouth, chews, and goes down a little
            var t = new Track();
            float[] lift = { 0.2f, 1f, 1f, 0.6f, 1f, 1f, 0.2f };
            for (int i = 0; i < lift.Length; i++)
            {
                var p = Pose.Standing();
                float k = lift[i];
                p.Arm("Right", 0.5f * k, 0.05f + 0.55f * k);
                p.Elbow("Right", 0.15f + 0.9f * k);
                p.Set("Right Forearm Twist In-Out", 0.4f * k);
                p.Arm("Left", 0.2f, 0.4f).Elbow("Left", 0.6f);   // the other hand holds the bowl
                p.Head(0.1f + 0.05f * k);
                t.Key(i * 0.8f, p);
            }
            return t.Clip(true);
        }
    }
}

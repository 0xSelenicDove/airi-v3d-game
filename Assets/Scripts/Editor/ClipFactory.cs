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
    /// capture: put a humanoid clip (an .fbx set to Humanoid, or an .anim) named Idle, Walk, Sit, Type, Lie or Eat in
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
            foreach (var name in new[] { "Sit", "Type", "Lie", "Eat" })
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
                Debug.Log("[ClipFactory] muscle signs: " + string.Join(", ", sign.Select(kv => $"{kv.Key}={kv.Value:+0;-0}")));
                Debug.Log($"[ClipFactory] rest body {restBody}");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(go);
            }
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
            public Pose Arm(string side, float up, float fwd) { Set($"{side} Arm Down-Up", up * sign["ArmUp"]); return Set($"{side} Arm Front-Back", fwd * sign["ArmFwd"]); }
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
                p.Arm("Left", -0.75f, 0.05f).Arm("Right", -0.75f, 0.05f);
                p.Elbow("Left", 0.15f).Elbow("Right", 0.15f);
                p.RelaxHands();
                return p;
            }

            public static Pose Seated()
            {
                var p = Standing();
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, 1.0f).Knee(s, 1.0f).Foot(s, 0.1f);
                p.Spine(0.05f);
                // hands resting on the thighs
                p.Arm("Left", -0.55f, 0.35f).Arm("Right", -0.55f, 0.35f);
                p.Elbow("Left", 0.45f).Elbow("Right", 0.45f);
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
            // breathing, and the weight shifting slowly from one foot to the other
            var t = new Track();
            for (int i = 0; i <= 4; i++)
            {
                float ph = i / 4f * Mathf.PI * 2f;
                var p = Pose.Standing();
                p.Spine(0.02f * Mathf.Sin(ph * 2f));
                p.Set("Spine Left-Right", 0.03f * Mathf.Sin(ph));
                p.Arm("Left", -0.75f + 0.015f * Mathf.Sin(ph * 2f), 0.05f).Arm("Right", -0.75f + 0.015f * Mathf.Sin(ph * 2f), 0.05f);
                p.body = restBody + new Vector3(0.012f * Mathf.Sin(ph), 0.004f * Mathf.Sin(ph * 2f), 0);
                t.Key(i * 1.25f, p);
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
                // arms swing against the legs
                p.Arm("Left", -0.72f, 0.05f - 0.22f * s).Arm("Right", -0.72f, 0.05f + 0.22f * s);
                p.Elbow("Left", 0.2f + 0.1f * Mathf.Max(0, -s)).Elbow("Right", 0.2f + 0.1f * Mathf.Max(0, s));
                p.Set("Spine Twist Left-Right", 0.06f * s);
                p.Spine(0.03f);
                // the body is highest over the standing leg, twice a cycle
                p.body = restBody + new Vector3(0.012f * s, -0.012f + 0.012f * Mathf.Cos(ph * 2f), 0);
                t.Key(i / (float)N * T, p);
            }
            return t.Clip(true);
        }

        static AnimationClip MakeSit()
        {
            var t = new Track();
            for (int i = 0; i <= 2; i++)
            {
                var p = Pose.Seated();
                p.Spine(0.05f + 0.015f * Mathf.Sin(i * Mathf.PI));
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
                p.Arm("Left", -0.45f, 0.55f).Arm("Right", -0.45f, 0.55f);
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
            // on the back, the head toward the character's back (the bed's head end); slow breathing
            var t = new Track();
            for (int i = 0; i <= 2; i++)
            {
                var p = Pose.Standing();
                p.Arm("Left", -0.7f, 0.1f).Arm("Right", -0.7f, 0.1f);
                p.Elbow("Left", 0.3f).Elbow("Right", 0.3f);
                foreach (var s in new[] { "Left", "Right" }) p.Thigh(s, 0.08f).Knee(s, 0.12f).Foot(s, -0.2f);
                p.Spine(-0.02f + 0.02f * Mathf.Sin(i * Mathf.PI));
                p.Head(0.12f);
                p.rot = Quaternion.AngleAxis(-90f, Vector3.right);
                t.Key(i * 2.5f, p);
            }
            return t.Clip(true);
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
                p.Arm("Right", -0.75f + 0.45f * k, 0.05f + 0.5f * k);
                p.Elbow("Right", 0.15f + 0.85f * k);
                p.Set("Right Forearm Twist In-Out", 0.4f * k);
                p.Arm("Left", -0.55f, 0.35f).Elbow("Left", 0.55f);   // the other hand holds the bowl
                p.Head(0.1f + 0.05f * k);
                t.Key(i * 0.8f, p);
            }
            return t.Clip(true);
        }
    }
}

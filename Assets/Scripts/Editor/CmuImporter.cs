using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace AiWorld.EditorTools
{
    /// <summary>
    /// Turns motion capture from the CMU library (https://mocap.cs.cmu.edu/, an .asf skeleton and .amc motions) into
    /// humanoid clips, inside Unity, with no other tool. Each CMU bone's rotation is carried over to the same humanoid
    /// bone of a reference avatar, and the avatar's muscle values are written as a clip, so it plays on every VRM.
    ///
    /// CMU rest pose: every bone unrotated, arms straight out. CMU axes: x to the actor's left, y up, z forward
    /// (right-handed), so a point moves to Unity by negating x.
    /// </summary>
    public static class CmuImporter
    {
        /// <summary>CMU capture rate</summary>
        public const float Fps = 120f;
        const string ReferenceAvatar = "Assets/Avatars/seed-san.vrm";

        internal class Bone
        {
            public string name;
            public Vector3 direction;
            public float length;
            public Quaternion axis = Quaternion.identity, axisInverse = Quaternion.identity;
            public string[] dof = Array.Empty<string>();
            public Bone parent;
        }

        /// <summary>a CMU skeleton and one take on it</summary>
        public class Motion
        {
            internal readonly Dictionary<string, Bone> bones = new();
            internal readonly List<Bone> order = new();     // parents first
            internal readonly List<Dictionary<string, float[]>> frames = new();
            internal float toMeters = 1f / 0.45f * 0.0254f;
            public int Frames => frames.Count;
            public float Seconds => frames.Count / Fps;
        }

        // ------------------------------------------------------------------ reading

        static float F(string s) => float.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);
        static readonly char[] Space = { ' ', '\t' };

        public static Motion Load(string asfPath, string amcPath)
        {
            var m = new Motion();
            ReadAsf(m, asfPath);
            ReadAmc(m, amcPath);
            return m;
        }

        static void ReadAsf(Motion m, string path)
        {
            var lines = File.ReadAllLines(path);
            string section = "";
            Bone bone = null;
            var root = new Bone { name = "root" };
            m.bones["root"] = root;
            var children = new Dictionary<string, string[]>();
            foreach (var raw in lines)
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                if (line[0] == ':') { section = line.Split(Space, StringSplitOptions.RemoveEmptyEntries)[0]; continue; }
                var t = line.Split(Space, StringSplitOptions.RemoveEmptyEntries);
                if (section == ":units" && t[0] == "length") m.toMeters = 1f / F(t[1]) * 0.0254f;
                else if (section == ":bonedata")
                {
                    switch (t[0])
                    {
                        case "begin": bone = new Bone(); break;
                        case "end": m.bones[bone.name] = bone; bone = null; break;
                        case "name": bone.name = t[1]; break;
                        case "direction": bone.direction = new Vector3(F(t[1]), F(t[2]), F(t[3])); break;
                        case "length": bone.length = F(t[1]); break;
                        case "axis":
                            if (t[4] != "XYZ") throw new InvalidDataException($"{path}: axis order {t[4]}");
                            bone.axis = Euler(F(t[1]), F(t[2]), F(t[3]));
                            bone.axisInverse = Quaternion.Inverse(bone.axis);
                            break;
                        case "dof": bone.dof = t.Skip(1).ToArray(); break;
                    }
                }
                else if (section == ":hierarchy" && t[0] != "begin" && t[0] != "end") children[t[0]] = t.Skip(1).ToArray();
            }
            void Walk(Bone b)
            {
                m.order.Add(b);
                if (!children.TryGetValue(b.name, out var kids)) return;
                foreach (var k in kids) { m.bones[k].parent = b; Walk(m.bones[k]); }
            }
            Walk(root);
        }

        static void ReadAmc(Motion m, string path)
        {
            Dictionary<string, float[]> frame = null;
            foreach (var raw in File.ReadLines(path))
            {
                var line = raw.Trim();
                if (line.Length == 0 || line[0] == '#' || line[0] == ':') continue;
                if (char.IsDigit(line[0]) && line.IndexOf(' ') < 0)
                {
                    frame = new Dictionary<string, float[]>();
                    m.frames.Add(frame);
                    continue;
                }
                var t = line.Split(Space, StringSplitOptions.RemoveEmptyEntries);
                var v = new float[t.Length - 1];
                for (int i = 1; i < t.Length; i++) v[i - 1] = F(t[i]);
                frame[t[0]] = v;
            }
        }

        /// <summary>the rotation order the ASF/AMC format uses: x first, then y, then z (fixed axes)</summary>
        static Quaternion Euler(float x, float y, float z) =>
            Quaternion.AngleAxis(z, Vector3.forward) * Quaternion.AngleAxis(y, Vector3.up) * Quaternion.AngleAxis(x, Vector3.right);

        static Quaternion ToUnity(Quaternion q) => new(q.x, -q.y, -q.z, q.w);
        static Vector3 ToUnity(Vector3 p) => new(-p.x, p.y, p.z);

        /// <summary>every bone's world rotation in this frame (Unity axes) and the root's position (metres, Unity axes)</summary>
        static Dictionary<string, Quaternion> Solve(Motion m, int frame, out Vector3 rootPosition)
        {
            var f = m.frames[Mathf.Clamp(frame, 0, m.frames.Count - 1)];
            var world = new Dictionary<string, Quaternion>(m.order.Count);
            var r = f["root"];
            rootPosition = ToUnity(new Vector3(r[0], r[1], r[2]) * m.toMeters);
            world["root"] = Euler(r[3], r[4], r[5]);
            foreach (var b in m.order)
            {
                if (b.parent == null) continue;
                float x = 0, y = 0, z = 0;
                if (f.TryGetValue(b.name, out var v))
                    for (int i = 0; i < b.dof.Length && i < v.Length; i++)
                    {
                        if (b.dof[i] == "rx") x = v[i];
                        else if (b.dof[i] == "ry") y = v[i];
                        else if (b.dof[i] == "rz") z = v[i];
                    }
                world[b.name] = world[b.parent.name] * b.axis * Euler(x, y, z) * b.axisInverse;
            }
            foreach (var b in m.order) world[b.name] = ToUnity(world[b.name]);
            return world;
        }

        // ------------------------------------------------------------------ carrying it over to an avatar

        /// <summary>
        /// a CMU bone, the humanoid bone it drives, and the bone that humanoid bone points at. The neck and head are left
        /// out: on another figure the captured neck throws the head back, so the head stays in line with the chest.
        /// </summary>
        static readonly (string src, HumanBodyBones dst, HumanBodyBones[] next)[] Map =
        {
            ("lowerback", HumanBodyBones.Spine, new[] { HumanBodyBones.Chest, HumanBodyBones.Neck }),
            ("upperback", HumanBodyBones.Chest, new[] { HumanBodyBones.UpperChest, HumanBodyBones.Neck }),
            ("thorax", HumanBodyBones.UpperChest, new[] { HumanBodyBones.Neck }),
            ("lclavicle", HumanBodyBones.LeftShoulder, new[] { HumanBodyBones.LeftUpperArm }),
            ("lhumerus", HumanBodyBones.LeftUpperArm, new[] { HumanBodyBones.LeftLowerArm }),
            ("lradius", HumanBodyBones.LeftLowerArm, new[] { HumanBodyBones.LeftHand }),
            ("rclavicle", HumanBodyBones.RightShoulder, new[] { HumanBodyBones.RightUpperArm }),
            ("rhumerus", HumanBodyBones.RightUpperArm, new[] { HumanBodyBones.RightLowerArm }),
            ("rradius", HumanBodyBones.RightLowerArm, new[] { HumanBodyBones.RightHand }),
            ("lfemur", HumanBodyBones.LeftUpperLeg, new[] { HumanBodyBones.LeftLowerLeg }),
            ("ltibia", HumanBodyBones.LeftLowerLeg, new[] { HumanBodyBones.LeftFoot }),
            ("lfoot", HumanBodyBones.LeftFoot, new[] { HumanBodyBones.LeftToes }),
            ("rfemur", HumanBodyBones.RightUpperLeg, new[] { HumanBodyBones.RightLowerLeg }),
            ("rtibia", HumanBodyBones.RightLowerLeg, new[] { HumanBodyBones.RightFoot }),
            ("rfoot", HumanBodyBones.RightFoot, new[] { HumanBodyBones.RightToes }),
        };

        /// <summary>poses a reference avatar from a take and reads back its muscle values</summary>
        public sealed class Retarget : IDisposable
        {
            readonly GameObject go;
            readonly Animator anim;
            readonly HumanPoseHandler handler;
            readonly Transform hips;
            readonly Quaternion hipsRest;
            readonly float[] restMuscles;
            public Vector3 RestBody { get; }
            readonly List<(string src, Transform t, Quaternion rest)> bones = new();
            readonly float scale;
            readonly Motion motion;
            HumanPose pose;

            public Animator Animator => anim;

            public Retarget(Motion m)
            {
                motion = m;
                go = (GameObject)UnityEngine.Object.Instantiate(AssetDatabase.LoadAssetAtPath<GameObject>(ReferenceAvatar));
                go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
                anim = go.GetComponent<Animator>();
                handler = new HumanPoseHandler(anim.avatar, go.transform);
                handler.GetHumanPose(ref pose);
                restMuscles = (float[])pose.muscles.Clone();
                RestBody = pose.bodyPosition;
                hips = anim.GetBoneTransform(HumanBodyBones.Hips);
                hipsRest = hips.rotation;

                foreach (var (src, dst, next) in Map)
                {
                    var t = anim.GetBoneTransform(dst);
                    if (!t || !m.bones.TryGetValue(src, out var b)) continue;
                    // both skeletons are near a T-pose but not the same one (the legs of one slope out): first turn the
                    // avatar's bone to the way the CMU bone points at rest
                    var align = Quaternion.identity;
                    var to = next.Select(anim.GetBoneTransform).FirstOrDefault(x => x);
                    if (to) align = Quaternion.FromToRotation((to.position - t.position).normalized, ToUnity(b.direction).normalized);
                    bones.Add((src, t, align * t.rotation));
                    // the CMU hand data is noisy: the hand keeps to the forearm, and the fingers rest curled
                    if (dst == HumanBodyBones.LeftLowerArm || dst == HumanBodyBones.RightLowerArm)
                    {
                        var hand = anim.GetBoneTransform(dst == HumanBodyBones.LeftLowerArm ? HumanBodyBones.LeftHand : HumanBodyBones.RightHand);
                        if (hand) bones.Add((src, hand, align * hand.rotation));
                    }
                }
                float legs = Vector3.Distance(anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg).position, anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg).position)
                           + Vector3.Distance(anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg).position, anim.GetBoneTransform(HumanBodyBones.LeftFoot).position);
                scale = legs / ((m.bones["lfemur"].length + m.bones["ltibia"].length) * m.toMeters);
            }

            /// <summary>
            /// the avatar's pose at a frame of the take. <paramref name="turn"/> and <paramref name="origin"/> place the
            /// take: it is turned about the vertical, and origin (Unity axes, metres, in the take) goes to x = z = 0.
            /// </summary>
            public HumanPose PoseAt(int frame, Quaternion turn, Vector3 origin)
            {
                var world = Solve(motion, frame, out var rootPosition);
                var p = rootPosition - new Vector3(origin.x, 0, origin.z);
                hips.SetPositionAndRotation(turn * p * scale, turn * world["root"] * hipsRest);
                foreach (var (src, t, rest) in bones) t.rotation = turn * world[src] * rest;
                handler.GetHumanPose(ref pose);
                for (int i = 0; i < pose.muscles.Length; i++)
                {
                    var n = HumanTrait.MuscleName[i];
                    // relaxed fingers, as in the made clips
                    if (n.EndsWith("Stretched") && !n.Contains("Thumb"))
                        pose.muscles[i] = Mathf.Clamp(restMuscles[i] - (n.Contains(" 1 ") ? 0.25f : 0.35f), -1f, 1f);
                    else
                    {
                        // the actor's collarbones move far more than an avatar's shoulders can: half of it reads right
                        if (n.Contains(" Shoulder ")) pose.muscles[i] = Mathf.Lerp(restMuscles[i], pose.muscles[i], 0.5f);
                        pose.muscles[i] = Mathf.Clamp(pose.muscles[i], -1f, 1f);
                    }
                }
                handler.SetHumanPose(ref pose);
                return pose;
            }

            /// <summary>the turn that makes the actor face +z at this frame, and where the actor stands then</summary>
            public (Quaternion turn, Vector3 origin) FaceForward(int frame)
            {
                var world = Solve(motion, frame, out var rootPosition);
                var f = world["root"] * Vector3.forward;
                f.y = 0;
                var turn = f.sqrMagnitude > 1e-4f ? Quaternion.FromToRotation(f.normalized, Vector3.forward) : Quaternion.identity;
                return (turn, rootPosition);
            }

            public void Dispose()
            {
                handler.Dispose();
                UnityEngine.Object.DestroyImmediate(go);
            }
        }

        // ------------------------------------------------------------------ writing a clip

        /// <summary>
        /// bake part of a take (from..to seconds) into a humanoid clip, sampled at 30 fps and played
        /// <paramref name="stretch"/> times as long, and backward if <paramref name="reverse"/>. The actor faces +z at
        /// <paramref name="from"/>. The body stays over the character's root: the routine that plays the clip moves the
        /// root, and holds the height.
        /// </summary>
        public static AnimationClip Bake(Motion m, float from, float to, float stretch = 1f, bool reverse = false)
        {
            const float rate = 30f;
            int first = Mathf.Clamp(Mathf.RoundToInt(from * Fps), 0, m.Frames - 1);
            int last = Mathf.Clamp(Mathf.RoundToInt(to * Fps), first + 1, m.Frames - 1);
            float seconds = (last - first) / Fps;
            int keys = Mathf.Max(2, Mathf.RoundToInt(seconds * rate) + 1);
            var poses = new HumanPose[keys];
            using (var r = new Retarget(m))
            {
                var (turn, origin) = r.FaceForward(first);
                Quaternion previous = default;
                for (int i = 0; i < keys; i++)
                {
                    var p = r.PoseAt(Mathf.RoundToInt(Mathf.Lerp(first, last, i / (float)(keys - 1))), turn, origin);
                    p.muscles = (float[])p.muscles.Clone();
                    p.bodyPosition = new Vector3(r.RestBody.x, p.bodyPosition.y, r.RestBody.z);
                    // a quaternion and its negative are the same turn: keep to one, or the curves blend the long way round
                    if (i > 0 && Quaternion.Dot(previous, p.bodyRotation) < 0f)
                        p.bodyRotation = new Quaternion(-p.bodyRotation.x, -p.bodyRotation.y, -p.bodyRotation.z, -p.bodyRotation.w);
                    previous = p.bodyRotation;
                    poses[i] = p;
                }
            }
            if (reverse) Array.Reverse(poses);
            var clip = new AnimationClip { frameRate = rate };
            void Curve(string prop, Func<HumanPose, float> value)
            {
                var c = new AnimationCurve(Enumerable.Range(0, keys).Select(i => new Keyframe(i / rate * stretch, value(poses[i]))).ToArray());
                for (int i = 0; i < c.length; i++) c.SmoothTangents(i, 0);
                AnimationUtility.SetEditorCurve(clip, EditorCurveBinding.FloatCurve("", typeof(Animator), prop), c);
            }
            Curve("RootT.x", p => p.bodyPosition.x);
            Curve("RootT.y", p => p.bodyPosition.y);
            Curve("RootT.z", p => p.bodyPosition.z);
            Curve("RootQ.x", p => p.bodyRotation.x);
            Curve("RootQ.y", p => p.bodyRotation.y);
            Curve("RootQ.z", p => p.bodyRotation.z);
            Curve("RootQ.w", p => p.bodyRotation.w);
            for (int i = 0; i < HumanTrait.MuscleCount; i++)
            {
                int j = i;
                Curve(ClipFactory.ClipProperty(HumanTrait.MuscleName[i]), p => p.muscles[j]);
            }
            var s = AnimationUtility.GetAnimationClipSettings(clip);
            s.loopTime = false;
            s.keepOriginalOrientation = true;
            s.keepOriginalPositionY = true;
            s.keepOriginalPositionXZ = true;
            s.loopBlendOrientation = true;
            s.loopBlendPositionY = true;
            s.loopBlendPositionXZ = true;
            AnimationUtility.SetAnimationClipSettings(clip, s);
            return clip;
        }

        // ------------------------------------------------------------------ the bed clips

        /// <summary>
        /// the takes the bed routine uses, from a folder holding the CMU files 111.asf and 111_12.amc: sitting with the
        /// knees up and lying back on the hands, and the same played backward for sitting up (the library's takes of
        /// getting up roll over onto the front first, which a bed has no room for)
        /// </summary>
        public static void ImportBedClips(string folder)
        {
            const string dir = "Assets/Animations/Mocap";
            Directory.CreateDirectory(dir);
            void Save(AnimationClip clip, string name)
            {
                clip.name = name;
                var path = $"{dir}/{name}.anim";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(clip, path);
                Debug.Log($"[CmuImporter] {path}: {clip.length:0.00} s");
            }
            var take = Load(Path.Combine(folder, "111.asf"), Path.Combine(folder, "111_12.amc"));
            Save(Bake(take, 6.2f, 9.7f), "LieBack");
            Save(Bake(take, 6.2f, 9.7f, 0.9f, reverse: true), "SitUp");
            AssetDatabase.SaveAssets();
        }

        [MenuItem("AiWorld/Import CMU Bed Clips")]
        static void ImportFromMenu()
        {
            var folder = EditorUtility.OpenFolderPanel("Folder with the CMU .asf and .amc files", "", "");
            if (!string.IsNullOrEmpty(folder)) ImportBedClips(folder);
        }
    }
}

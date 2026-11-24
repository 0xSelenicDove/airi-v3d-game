using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace AiWorld.Agents
{
    /// <summary>
    /// The body's motion, generated live by the ARDY server (tools/ardy): standing, gestures, and walking along a NavMesh
    /// path, and sitting, standing up and getting in and out of bed, where the stream also moves the character. The game
    /// gives it the places and heights (ARDY knows nothing about the room), and this layer keeps hands on what they hold.
    /// The server sends each character its own stream of poses a little ahead of playback, and they play over the
    /// Animator's pose, blending in and out. Without a server the game plays its clips as usual.
    /// </summary>
    public sealed class LiveMotion : IDisposable
    {
        const string DefaultUrl = "ws://127.0.0.1:8791";
        const string IdlePrompt = "idle", RelaxPrompt = "relax";
        // the model tends to hold the pose it is in: going straight from one gesture to another reached the new one in
        // 11 of 24 tries, and through a short relax step in 24 of 24
        const float RelaxSeconds = 0.8f;
        const float BlendIn = 0.45f, BlendOut = 0.25f;
        const int StartBuffer = 8;
        /// <summary>how slowly the standing balance follows the generated posture: breathing and sway stay, a lean does not</summary>
        const float BalanceSeconds = 0.9f;
        /// <summary>the legs reach this share of their length, so the knees stay soft and never lock or pop</summary>
        const float LegReach = 0.995f;
        /// <summary>how quickly a joint follows the stream (s): takes out the small jumps where generated windows meet</summary>
        const float JointSmoothing = 0.05f;
        /// <summary>the share of the generated shoulder motion that is used: all of it rolls an avatar's shoulders forward</summary>
        const float ShoulderShare = 0.5f;
        /// <summary>how much of the spine's slow bend is taken out while standing</summary>
        const float SpineHold = 0.9f;
        /// <summary>each foot stands this far outside its T-pose place: feet straight under the hips look narrow and unsteady</summary>
        const float StanceOut = 0.025f;
        /// <summary>how far each standing foot turns outward (degrees)</summary>
        const float ToeOut = 7f;
        /// <summary>how long the feet take to settle flat when a walk ends (s)</summary>
        const float FootSettle = 0.3f;
        /// <summary>how fast the standing hips drift back over the feet after a walk (m/s)</summary>
        const float RecentreSpeed = 0.06f;
        /// <summary>floats before the bones in each frame: hips offset, game x, z, yaw, and whether the stream moves the body</summary>
        const int FrameHead = 7;
        /// <summary>how far the neck and head can turn from rest (degrees): the turn is free up to the knee and eases into the limit</summary>
        const float NeckKnee = 12f, NeckLimit = 24f, HeadKnee = 18f, HeadLimit = 36f;
        /// <summary>
        /// how slowly the arms' resting place follows the generated motion (s): the offset goes, and 94% of a walking
        /// swing stays. At 1.2 s it never caught up in a short walk across a room.
        /// </summary>
        const float ArmSettleSeconds = 0.5f;
        /// <summary>
        /// turning the head is done here, over the standing stream: ARDY ignores "turn the head", and "look over the
        /// shoulder" turns the whole body about 90 degrees on planted feet. Degrees to each side, the neck's share, and
        /// how long the turn takes to arrive (s).
        /// </summary>
        const float HeadTurnAngle = 60f, NeckTurnShare = 0.4f, HeadTurnSeconds = 0.28f;
        static readonly Dictionary<string, float> HeadTurns = new() { ["look_left"] = -1f, ["look_right"] = 1f };
        /// <summary>
        /// swinging the arms is also done here: of the prompts tried, most left the arms still and the one that moved them
        /// swung them out and across and sometimes turned the body. Degrees each way, extra elbow bend on the forward
        /// swing, the chest's turn against the arms, one full swing (s), and how long it takes to start and stop (s).
        /// </summary>
        const float SwingAngle = 28f, SwingElbow = 16f, SwingChest = 3.5f, SwingSeconds = 1.1f, SwingEase = 0.35f;
        const string SwingGesture = "swing_arms";
        /// <summary>where a hanging upper arm points: this far out from the body and forward of straight down (degrees)</summary>
        const float ArmOut = 12f, ArmForward = 2f;
        /// <summary>
        /// how far an upper arm can go behind the body (degrees from straight down, in the body's frame): free up to the
        /// knee, then easing into the limit. In short walks the slow centring never caught up, and starts, stops and
        /// getting up held the arms 15 to 27 degrees back. A run swings further back on purpose.
        /// </summary>
        const float BackKnee = -12f, BackLimit = -26f, RunBackKnee = -40f, RunBackLimit = -62f;
        /// <summary>an arm this far from hanging (degrees) stops following the avatar's own hanging pose and follows the stream</summary>
        const float HangFrom = 35f, HangTo = 85f;
        /// <summary>how far the upper arm rolls to line its elbow up with the fold, and how far the hand can roll (degrees)</summary>
        const float MaxArmRoll = 95f, MaxHandRoll = 100f;
        /// <summary>the share of the hand's roll the forearm takes: these avatars have no twist bones, so one joint alone wrings the skin</summary>
        const float ForearmShare = 0.5f;
        /// <summary>how quickly the upper arm's roll follows (s)</summary>
        const float ArmRollSeconds = 0.06f;
        /// <summary>the longest the relax step waits for raised arms to come down (s): they took up to 1.9 s in 24 tries</summary>
        const float LowerArmsSeconds = 2.2f;

        // the limbs turn to the stream skeleton's rest direction. The spine, neck and shoulders do not: an avatar's chest
        // curves back about 16 degrees at rest, and forcing the stream's straight spine onto it reads as a hunched back
        static readonly Dictionary<HumanBodyBones, HumanBodyBones[]> Next = new()
        {
            [HumanBodyBones.LeftUpperArm] = new[] { HumanBodyBones.LeftLowerArm },
            [HumanBodyBones.LeftLowerArm] = new[] { HumanBodyBones.LeftHand },
            [HumanBodyBones.RightUpperArm] = new[] { HumanBodyBones.RightLowerArm },
            [HumanBodyBones.RightLowerArm] = new[] { HumanBodyBones.RightHand },
            [HumanBodyBones.LeftUpperLeg] = new[] { HumanBodyBones.LeftLowerLeg },
            [HumanBodyBones.LeftLowerLeg] = new[] { HumanBodyBones.LeftFoot },
            [HumanBodyBones.LeftFoot] = new[] { HumanBodyBones.LeftToes },
            [HumanBodyBones.RightUpperLeg] = new[] { HumanBodyBones.RightLowerLeg },
            [HumanBodyBones.RightLowerLeg] = new[] { HumanBodyBones.RightFoot },
            [HumanBodyBones.RightFoot] = new[] { HumanBodyBones.RightToes },
        };

        // a hand has no next bone in the stream: it keeps the forearm's fit
        static readonly Dictionary<HumanBodyBones, HumanBodyBones> SameFitAs = new()
        {
            [HumanBodyBones.LeftHand] = HumanBodyBones.LeftLowerArm,
            [HumanBodyBones.RightHand] = HumanBodyBones.RightLowerArm,
            [HumanBodyBones.LeftToes] = HumanBodyBones.LeftFoot,
            [HumanBodyBones.RightToes] = HumanBodyBones.RightFoot,
        };

        /// <summary>one move of a furniture routine: where the root goes, how high the hips are (null: standing), and an optional full-body pose</summary>
        public struct StageStep
        {
            public string prompt, pose;
            public float seconds;
            public Vector3 position;
            public Quaternion facing;
            public float? hipsY;
        }

        sealed class Bone
        {
            public Transform transform;
            public Quaternion rest, restLocal, smooth, bias = Quaternion.identity;
            public int index;
            public bool shoulder, spine, foot;
            public float knee, limit;
        }

        /// <summary>one arm in the T-pose, for keeping the elbow a hinge and sharing the hand's roll along the forearm</summary>
        sealed class ArmChain
        {
            public Transform upper, lower, hand, chest;
            public Quaternion chestRest, lowerRest, handRest, centre = Quaternion.identity;
            public Vector3 restDirection, upperAxis, lowerAxis, upperFront, hangDirection;
            public float roll, hang = 1f;
        }

        sealed class Batch
        {
            public int start, count, boneCount, epoch;
            public float[] data;
        }

        readonly Animator anim;
        readonly Transform root, mover;
        readonly Transform hips, spine, neck, headBone, leftFoot, rightFoot, leftUpperLeg, rightUpperLeg, leftLowerLeg, rightLowerLeg;
        readonly Transform leftUpperArm, rightUpperArm, leftLowerArm, rightLowerArm, leftHand, rightHand;
        readonly ArmChain leftArm, rightArm;
        Vector3 leftHandGoal, rightHandGoal;
        float leftHandWeight, rightHandWeight;
        string pendingPrompt;
        readonly Dictionary<HumanBodyBones, (Quaternion rotation, Vector3 position)> rest = new();
        readonly Dictionary<HumanBodyBones, Quaternion> restLocal = new();
        readonly List<Bone> bones = new();
        readonly Dictionary<int, float[]> frames = new();
        readonly ConcurrentQueue<object> inbox = new();
        readonly ConcurrentQueue<string> outbox = new();
        readonly SemaphoreSlim outboxSignal = new(0);
        readonly CancellationTokenSource stop = new();
        readonly string url;

        Task worker;
        bool connected, streaming, playing;
        int fps = 30, boneCount, stride, epoch;
        float clock, weight, nextAt, gestureUntil, relaxUntil, nextSeconds, scale = 1f, hipsHeight;
        Vector3 hipsRest, hipsSmooth, torsoRest, leftPlant, rightPlant, leftPlantRest, rightPlantRest;
        Vector3 lastLeftFoot, lastRightFoot, lastHips;
        Vector2 hipsBias, standCentre;
        JObject pendingWalk;
        bool walking, walkMoved, wasMoving, running;
        float headTurn, headTurnSpeed, headTurnGoal, headTurnUntil;
        float swingAmount, swingPhase, swingUntil;
        float walkAskedAt, walkEndedAt = -9f, footBlend = 1f;
        Quaternion upright = Quaternion.identity, leftFootRest = Quaternion.identity, rightFootRest = Quaternion.identity;
        bool balanced;
        string prompt, nextGesture;
        float promptSentAt = -1f;
        string[] gestures = Array.Empty<string>();

        /// <summary>the server is connected and the character's bones are fitted to it</summary>
        public bool Available => connected && bones.Count > 0;
        public IReadOnlyList<string> Gestures => gestures;
        public float Weight => weight;
        public string Prompt => prompt;
        /// <summary>the stream is walking the character along the path it was given</summary>
        public bool Walking => walking;
        /// <summary>added to a held furniture pose's place, when what it sits on moves (a chair sliding in)</summary>
        public Vector3 StageOffset { get; set; }
        /// <summary>frames ready past the playback position</summary>
        public int Ahead { get; private set; }
        /// <summary>times playback had to wait for the next frame</summary>
        public int Underruns { get; private set; }
        /// <summary>seconds from asking for a new motion to its first frames arriving</summary>
        public float LastResponse { get; private set; } = -1f;

        public LiveMotion(Animator animator, Transform avatarRoot)
        {
            anim = animator;
            root = avatarRoot;
            mover = avatarRoot.parent ? avatarRoot.parent : avatarRoot;
            hips = anim.GetBoneTransform(HumanBodyBones.Hips);
            leftFoot = anim.GetBoneTransform(HumanBodyBones.LeftFoot);
            rightFoot = anim.GetBoneTransform(HumanBodyBones.RightFoot);
            spine = anim.GetBoneTransform(HumanBodyBones.Spine);
            neck = anim.GetBoneTransform(HumanBodyBones.Neck);
            headBone = anim.GetBoneTransform(HumanBodyBones.Head);
            leftUpperLeg = anim.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            rightUpperLeg = anim.GetBoneTransform(HumanBodyBones.RightUpperLeg);
            leftLowerLeg = anim.GetBoneTransform(HumanBodyBones.LeftLowerLeg);
            rightLowerLeg = anim.GetBoneTransform(HumanBodyBones.RightLowerLeg);
            leftUpperArm = anim.GetBoneTransform(HumanBodyBones.LeftUpperArm);
            rightUpperArm = anim.GetBoneTransform(HumanBodyBones.RightUpperArm);
            leftLowerArm = anim.GetBoneTransform(HumanBodyBones.LeftLowerArm);
            rightLowerArm = anim.GetBoneTransform(HumanBodyBones.RightLowerArm);
            leftHand = anim.GetBoneTransform(HumanBodyBones.LeftHand);
            rightHand = anim.GetBoneTransform(HumanBodyBones.RightHand);
            url = UrlFromArgs();
            // the avatar is in its T-pose until the Animator first runs
            foreach (HumanBodyBones b in Enum.GetValues(typeof(HumanBodyBones)))
            {
                if (b == HumanBodyBones.LastBone) continue;
                var t = anim.GetBoneTransform(b);
                if (!t) continue;
                rest[b] = (Quaternion.Inverse(root.rotation) * t.rotation, root.InverseTransformPoint(t.position));
                restLocal[b] = t.localRotation;
            }
            leftArm = MakeChain(leftUpperArm, leftLowerArm, leftHand);
            rightArm = MakeChain(rightUpperArm, rightLowerArm, rightHand);
            if (hips) hipsRest = rest[HumanBodyBones.Hips].position;
            // the T-pose is the balanced stance: the hips over the ankles and the torso upright
            if (hips && neck) torsoRest = rest[HumanBodyBones.Neck].position - hipsRest;
            if (leftFoot)
            {
                leftPlant = leftPlantRest = rest[HumanBodyBones.LeftFoot].position + Vector3.left * StanceOut;
                leftFootRest = Quaternion.Euler(0f, -ToeOut, 0f) * rest[HumanBodyBones.LeftFoot].rotation;
            }
            if (rightFoot)
            {
                rightPlant = rightPlantRest = rest[HumanBodyBones.RightFoot].position + Vector3.right * StanceOut;
                rightFootRest = Quaternion.Euler(0f, ToeOut, 0f) * rest[HumanBodyBones.RightFoot].rotation;
            }
        }

        ArmChain MakeChain(Transform upper, Transform lower, Transform hand)
        {
            var chestBone = anim.GetBoneTransform(HumanBodyBones.UpperChest) ? anim.GetBoneTransform(HumanBodyBones.UpperChest) : anim.GetBoneTransform(HumanBodyBones.Chest);
            if (!upper || !lower || !hand || !chestBone) return null;
            var toCharacter = Quaternion.Inverse(root.rotation);
            float side = Mathf.Sign((toCharacter * (lower.position - upper.position)).x);
            return new ArmChain
            {
                hangDirection = new Vector3(side * Mathf.Tan(ArmOut * Mathf.Deg2Rad), -1f, Mathf.Tan(ArmForward * Mathf.Deg2Rad)).normalized,
                upper = upper, lower = lower, hand = hand,
                chest = chestBone,
                chestRest = toCharacter * chestBone.rotation,
                lowerRest = lower.localRotation,
                handRest = hand.localRotation,
                restDirection = (toCharacter * (lower.position - upper.position)).normalized,
                upperAxis = lower.localPosition.normalized,
                lowerAxis = hand.localPosition.normalized,
                upperFront = Quaternion.Inverse(toCharacter * upper.rotation) * Vector3.forward,
            };
        }

        static string UrlFromArgs()
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == "-ardy") return args[i + 1] == "off" ? null : args[i + 1];
            return DefaultUrl;
        }

        /// <summary>where a bone is in the T-pose, relative to the character</summary>
        public Vector3 RestPosition(HumanBodyBones bone) => rest.TryGetValue(bone, out var r) ? r.position : Vector3.zero;

        /// <summary>play a gesture for some seconds, then go back to standing. False if it cannot play now.</summary>
        public bool Play(string gesture, float seconds = 3.5f)
        {
            if (!Available || !gestures.Contains(gesture)) return false;
            nextGesture = gesture;
            nextSeconds = seconds;
            if (streaming)
            {
                if (prompt == IdlePrompt) StartNext();
                else if (prompt != RelaxPrompt) Relax();
            }
            return true;
        }

        /// <summary>walk along these NavMesh corners: the stream moves the character until <see cref="Walking"/> ends</summary>
        public bool Walk(Vector3[] corners, float speed, bool run = false)
        {
            if (!Available || corners.Length < 2) return false;
            var path = new JArray();
            foreach (var c in corners.Skip(1)) path.Add(new JArray(c.x, c.z));
            pendingWalk = new JObject { ["t"] = "walk", ["path"] = path, ["speed"] = speed, ["scale"] = scale, ["run"] = run };
            pendingPrompt = run ? "motion_run" : "motion_walk";
            nextGesture = null;
            walking = true;
            running = run;
            walkMoved = false;
            walkAskedAt = Time.time;
            return true;
        }

        /// <summary>
        /// move through furniture poses: the stream moves the character until <see cref="Walking"/> ends. With
        /// <paramref name="hold"/> the last pose is held until the next stage.
        /// </summary>
        public bool Stage(IReadOnlyList<StageStep> steps, bool hold)
        {
            if (!Available || steps.Count == 0) return false;
            var list = new JArray();
            foreach (var s in steps)
            {
                float rootY = s.hipsY.HasValue ? hipsHeight + (s.hipsY.Value - mover.position.y - hipsRest.y) / scale : hipsHeight;
                var step = new JObject
                {
                    ["prompt"] = s.prompt, ["seconds"] = s.seconds, ["x"] = s.position.x, ["z"] = s.position.z,
                    ["yaw"] = s.facing.eulerAngles.y * Mathf.Deg2Rad, ["rootY"] = rootY,
                };
                if (s.pose != null) step["pose"] = s.pose;
                list.Add(step);
            }
            pendingWalk = new JObject { ["t"] = "stage", ["steps"] = list, ["hold"] = hold, ["scale"] = scale };
            pendingPrompt = "motion_stage";
            nextGesture = null;
            walking = true;
            walkMoved = false;
            walkAskedAt = Time.time;
            return true;
        }

        /// <summary>change what a held furniture pose is doing (for example from sitting to typing)</summary>
        public void HoldPrompt(string name)
        {
            if (walking && streaming) Send(new JObject { ["t"] = "play", ["prompt"] = name });
        }

        /// <summary>where a hand is reaching during a furniture stage (the Animator's IK does not apply over the stream)</summary>
        public void SetHand(bool left, Vector3 goal, float reach)
        {
            if (left) { leftHandGoal = goal; leftHandWeight = reach; }
            else { rightHandGoal = goal; rightHandWeight = reach; }
        }

        void StartNext()
        {
            gestureUntil = Time.time + nextSeconds;
            if (HeadTurns.TryGetValue(nextGesture, out float side))
            {
                headTurnGoal = side * HeadTurnAngle;
                headTurnUntil = gestureUntil;
                swingUntil = 0f;
                Ask(IdlePrompt);
            }
            else if (nextGesture == SwingGesture)
            {
                swingUntil = gestureUntil;
                headTurnUntil = 0f;
                Ask(IdlePrompt);
            }
            else
            {
                headTurnUntil = swingUntil = 0f;
                Ask(nextGesture);
            }
            nextGesture = null;
        }

        void Relax()
        {
            relaxUntil = Time.time + RelaxSeconds;
            Ask(RelaxPrompt);
        }

        /// <summary>gesture, then a relax step, then the next gesture or standing</summary>
        void Sequence()
        {
            if (prompt == RelaxPrompt)
            {
                if (Time.time < relaxUntil) return;
                // raised arms need longer, and the idle prompt alone brings them down slowly
                if (ArmsRaised && Time.time < relaxUntil + LowerArmsSeconds - RelaxSeconds) return;
                if (nextGesture != null) StartNext();
                else Ask(IdlePrompt);
            }
            else if (prompt != IdlePrompt && Time.time >= gestureUntil) Relax();
        }

        bool ArmsRaised => (leftArm != null && leftArm.hang < 0.5f) || (rightArm != null && rightArm.hang < 0.5f);

        /// <summary>call once per frame, after the Animator, before anything that adjusts the final pose</summary>
        public void Apply(bool standing, bool free, float dt)
        {
            if (url == null || !hips) return;
            if (standing && worker == null) worker = Task.Run(Run);
            Receive();
            // a walk that never started moving (the server stalled) gives the character back to the NavMesh
            if (walking && (!Available || (!walkMoved && Time.time - walkAskedAt > 4f))) EndWalk();
            // just after a walk the body stays on the stream, so it does not drop to the clip and back
            bool want = (standing || walking || (free && Time.time < walkEndedAt + 1f)) && Available;
            if (want && !streaming)
            {
                streaming = true;
                playing = false;
                clock = 0f;
                prompt = null;
                if (nextGesture != null) StartNext();
                else Ask(IdlePrompt);
            }
            if (pendingWalk != null && streaming)
            {
                pendingWalk["frame"] = Mathf.FloorToInt(clock);
                pendingWalk["x"] = mover.position.x;
                pendingWalk["z"] = mover.position.z;
                pendingWalk["yaw"] = mover.eulerAngles.y * Mathf.Deg2Rad;
                outbox.Enqueue(pendingWalk.ToString(Newtonsoft.Json.Formatting.None));
                outboxSignal.Release();
                pendingWalk = null;
                prompt = pendingPrompt;
            }
            if (want && !walking) Sequence();
            footBlend = Mathf.MoveTowards(footBlend, 1f, dt / FootSettle);

            if (streaming) Advance(dt);
            weight = Mathf.MoveTowards(weight, want && playing ? 1f : 0f, dt / (want ? BlendIn : BlendOut));
            if (streaming && !want && weight <= 0f) Pause();
            if (weight > 0f && playing) Pose(Mathf.SmoothStep(0f, 1f, weight), dt);
            else balanced = false;
        }

        void EndWalk()
        {
            walking = running = false;
            pendingWalk = null;
            walkEndedAt = Time.time;
            StageOffset = Vector3.zero;
            if (prompt is "motion_walk" or "motion_run" or "motion_stage") prompt = IdlePrompt;
        }

        void Ask(string next)
        {
            if (!streaming || next == prompt) return;
            prompt = next;
            promptSentAt = Time.realtimeSinceStartup;
            Send(new JObject { ["t"] = "play", ["prompt"] = next });
        }

        void Pause()
        {
            streaming = playing = wasMoving = false;
            prompt = nextGesture = null;
            headTurn = headTurnSpeed = headTurnUntil = 0f;
            swingAmount = swingUntil = 0f;
            if (walking) EndWalk();
            frames.Clear();
            clock = 0f;
            Ahead = 0;
            epoch++;
            Send(new JObject { ["t"] = "pause" });
        }

        void Advance(float dt)
        {
            int now = Mathf.FloorToInt(clock);
            Ahead = 0;
            while (frames.ContainsKey(now + Ahead + 1)) Ahead++;
            if (!playing)
            {
                if (frames.ContainsKey(now) && Ahead >= StartBuffer) playing = true;
                else return;
            }
            float next = clock + dt * fps;
            if (frames.ContainsKey(Mathf.FloorToInt(next) + 1)) clock = next;
            else Underruns++;
            for (int old = now - 3; frames.Remove(old); old--) { }
            if (Time.unscaledTime >= nextAt)
            {
                nextAt = Time.unscaledTime + 0.1f;
                Send(new JObject { ["t"] = "at", ["frame"] = Mathf.FloorToInt(clock) });
            }
        }

        void Pose(float w, float dt)
        {
            int f = Mathf.FloorToInt(clock);
            if (!frames.TryGetValue(f, out var a)) return;
            if (!frames.TryGetValue(f + 1, out var b)) b = a;
            float u = clock - f;
            float settle = 1f - Mathf.Exp(-dt / BalanceSeconds);
            float follow = 1f - Mathf.Exp(-dt / JointSmoothing);

            bool moving = a[6] > 0.5f, staged = a[6] > 1.5f;
            if (moving)
            {
                walkMoved = true;
                float nextX = b[6] > 0.5f ? b[3] : a[3], nextZ = b[6] > 0.5f ? b[4] : a[4], nextYaw = b[6] > 0.5f ? b[5] : a[5];
                var place = new Vector3(Mathf.Lerp(a[3], nextX, u), mover.position.y, Mathf.Lerp(a[4], nextZ, u));
                if (staged) place += new Vector3(StageOffset.x, 0f, StageOffset.z);
                mover.SetPositionAndRotation(place, Quaternion.Euler(0f, Mathf.LerpAngle(a[5] * Mathf.Rad2Deg, nextYaw * Mathf.Rad2Deg, u), 0f));
            }

            var offset = Vector3.Lerp(new Vector3(a[0], a[1], a[2]), new Vector3(b[0], b[1], b[2]), u);
            hipsSmooth = balanced ? Vector3.Lerp(hipsSmooth, offset, follow) : offset;
            offset = hipsSmooth;
            var flat = new Vector2(offset.x, offset.z);
            if (!balanced)
            {
                hipsBias = moving ? Vector2.zero : flat;
                standCentre = Vector2.zero;
                leftPlant = leftPlantRest;
                rightPlant = rightPlantRest;
                footBlend = 1f;
            }
            else if (wasMoving && !moving) StopWalking(flat);
            // only while standing: a bow or a stretch moves the hips on purpose
            else if (!moving && prompt == IdlePrompt) hipsBias = Vector2.Lerp(hipsBias, flat, settle);
            wasMoving = moving;
            if (!moving)
            {
                var feetCentre = (leftPlant + rightPlant - leftPlantRest - rightPlantRest) * 0.5f;
                standCentre = Vector2.MoveTowards(standCentre, new Vector2(feetCentre.x, feetCentre.z), RecentreSpeed * dt);
            }
            var hipsLocal = hipsRest + new Vector3(standCentre.x, 0f, standCentre.y)
                            + new Vector3(offset.x - hipsBias.x, offset.y - hipsHeight, offset.z - hipsBias.y) * scale;
            hips.position = Vector3.Lerp(hips.position, root.TransformPoint(hipsLocal), w);

            foreach (var bone in bones)
            {
                int i = FrameHead + bone.index * 4;
                var qa = new Quaternion(a[i], a[i + 1], a[i + 2], a[i + 3]);
                var qb = new Quaternion(b[i], b[i + 1], b[i + 2], b[i + 3]);
                var pose = Quaternion.Slerp(qa, qb, u);
                bone.smooth = balanced ? Quaternion.Slerp(bone.smooth, pose, follow) : pose;
                var target = root.rotation * bone.smooth * bone.rest;
                if (bone.shoulder) target = Quaternion.Slerp(bone.transform.parent.rotation * bone.restLocal, target, ShoulderShare);
                // standing feet are planted (see PlantFeet): the stream only drives them while walking, and as a walk ends
                float boneWeight = bone.foot && !moving ? w * (1f - footBlend) : w;
                bone.transform.rotation = Quaternion.Slerp(bone.transform.rotation, target, boneWeight);
                // (a furniture pose bends on purpose: the standing corrections hold still through it)
                // (a run leans on purpose, so it keeps its own spine)
                if (bone.spine) HoldSpineShape(bone, w, settle, moving && !staged && !running);
                if (bone.limit > 0f) LimitJoint(bone);
            }

            if (!staged) KeepUpright(w, settle);
            TurnHead(w, dt);
            float armSettle = 1f - Mathf.Exp(-dt / ArmSettleSeconds);
            CentreArm(leftArm, w, armSettle, moving, staged);
            CentreArm(rightArm, w, armSettle, moving, staged);
            LimitArmBack(leftArm, w);
            LimitArmBack(rightArm, w);
            SwingArms(w, dt);
            SolveArm(leftArm, w, dt);
            SolveArm(rightArm, w, dt);
            if (staged)
            {
                ReachHand(leftUpperArm, leftLowerArm, leftHand, leftHandGoal, leftHandWeight * w, -1f);
                ReachHand(rightUpperArm, rightLowerArm, rightHand, rightHandGoal, rightHandWeight * w, 1f);
            }
            if (!moving) PlantFeet(w * footBlend);
            lastLeftFoot = root.InverseTransformPoint(leftFoot.position);
            lastRightFoot = root.InverseTransformPoint(rightFoot.position);
            lastHips = root.InverseTransformPoint(hips.position);
            balanced = true;
        }

        /// <summary>the walk has ended: the feet stay where they came down, and the hips carry on from where they are</summary>
        void StopWalking(Vector2 flat)
        {
            leftPlant = new Vector3(lastLeftFoot.x, leftPlantRest.y, lastLeftFoot.z);
            rightPlant = new Vector3(lastRightFoot.x, rightPlantRest.y, lastRightFoot.z);
            standCentre = new Vector2(lastHips.x - hipsRest.x, lastHips.z - hipsRest.z);
            hipsBias = flat;
            footBlend = 0f;
            EndWalk();
            prompt = IdlePrompt;
        }

        /// <summary>
        /// while standing, the slow bend of each spine joint is taken out, so the back keeps the avatar's own curve and the
        /// chest stays open. Quick motion stays. During a gesture the correction holds, so a bow still bends the back.
        /// </summary>
        void HoldSpineShape(Bone bone, float w, float settle, bool moving)
        {
            var bend = bone.transform.localRotation * Quaternion.Inverse(bone.restLocal);
            if (!balanced) bone.bias = bend;
            else if (moving || prompt == IdlePrompt) bone.bias = Quaternion.Slerp(bone.bias, bend, settle);
            bone.transform.localRotation = Quaternion.Inverse(Quaternion.Slerp(Quaternion.identity, bone.bias, w * SpineHold)) * bone.transform.localRotation;
        }

        /// <summary>
        /// standing and walking, the arm's slow average is turned to hang at the side of the body, and the swing around it
        /// stays. The turn fades as the arm leaves its hanging place, so a raised arm goes where the stream sends it. A
        /// run and a furniture pose hold their arms on purpose, so there the turn lets go.
        /// </summary>
        void CentreArm(ArmChain a, float w, float settle, bool moving, bool staged)
        {
            if (a == null) return;
            var carried = Carried(a);
            var along = (Quaternion.Inverse(carried) * (a.lower.position - a.upper.position)).normalized;
            a.hang = 1f - Ease(HangFrom, HangTo, Vector3.Angle(along, Vector3.down));
            var wanted = staged || running ? Quaternion.identity : Quaternion.FromToRotation(along, a.hangDirection);
            if (!balanced) a.centre = wanted;
            else if (staged || running || moving || prompt == IdlePrompt) a.centre = Quaternion.Slerp(a.centre, wanted, settle);
            var turn = Quaternion.Slerp(Quaternion.identity, a.centre, w * a.hang);
            a.upper.rotation = carried * turn * Quaternion.Inverse(carried) * a.upper.rotation;
        }

        static float Ease(float from, float to, float value) => Mathf.SmoothStep(0f, 1f, Mathf.InverseLerp(from, to, value));

        /// <summary>
        /// the character's frame as the chest carries it now, so "hanging" also means along the body when bowing or lying.
        /// (Not the shoulder: after a walk the stream draws the shoulders back, and the arms went 12 degrees back with them.)
        /// </summary>
        static Quaternion Carried(ArmChain a) => a.chest.rotation * Quaternion.Inverse(a.chestRest);

        /// <summary>
        /// a raised or bent arm: the bone directions stay as generated, and the rolls are rebuilt. The upper arm rolls so
        /// the elbow folds toward its front, the forearm follows that hinge and takes a share of the hand's roll, and the
        /// hand keeps the way it faces.
        /// </summary>
        void SolveArm(ArmChain a, float w, float dt)
        {
            if (a == null) return;
            var carried = Carried(a);
            var toCarried = Quaternion.Inverse(carried);
            var u = (a.lower.position - a.upper.position).normalized;
            var f = (a.hand.position - a.lower.position).normalized;
            float bend = Vector3.Angle(u, f);
            var along = toCarried * u;
            float amount = Mathf.Max(Ease(HangFrom, HangTo, Vector3.Angle(along, Vector3.down)), Ease(40f, 70f, bend)) * w;
            if (amount <= 0f) return;
            var lowerNow = a.lower.rotation;
            var handNow = a.hand.rotation;

            // the front of a straight arm: the least turn from the T-pose. Reaching across the body that turn is
            // undefined, so there the arm keeps the roll it was generated with.
            var free = Quaternion.FromToRotation(a.restDirection, along) * Vector3.forward;
            free = Vector3.Slerp(free, toCarried * (a.upper.rotation * a.upperFront), Ease(-0.6f, -0.9f, Vector3.Dot(a.restDirection, along)));
            var front = carried * Vector3.ProjectOnPlane(free, along).normalized;
            float want = 0f, fold = Ease(12f, 35f, bend);
            if (fold > 0f)
            {
                float toFold = Vector3.SignedAngle(front, Vector3.ProjectOnPlane(f, u), u);
                // (a fold straight behind the arm is not a real elbow: it stays on the straight arm's front)
                want = Mathf.Clamp(toFold, -MaxArmRoll, MaxArmRoll) * fold * (1f - Ease(110f, 150f, Mathf.Abs(toFold)));
            }
            a.roll = balanced ? Mathf.LerpAngle(a.roll, want, 1f - Mathf.Exp(-dt / ArmRollSeconds)) : want;
            var upper = Quaternion.LookRotation(u, Quaternion.AngleAxis(a.roll, u) * front) * Quaternion.Inverse(Quaternion.LookRotation(a.upperAxis, a.upperFront));
            a.upper.rotation = Quaternion.Slerp(a.upper.rotation, upper, amount);

            var hinge = Quaternion.FromToRotation(u, f) * (a.upper.rotation * a.lowerRest);
            hinge = Quaternion.FromToRotation(hinge * a.lowerAxis, f) * hinge;
            var turn = handNow * Quaternion.Inverse(hinge * a.handRest);
            float handRoll = Mathf.DeltaAngle(0f, 2f * Mathf.Atan2(Vector3.Dot(new Vector3(turn.x, turn.y, turn.z), f), turn.w) * Mathf.Rad2Deg);
            float kept = Mathf.Clamp(handRoll, -MaxHandRoll, MaxHandRoll);
            a.lower.rotation = Quaternion.Slerp(lowerNow, Quaternion.AngleAxis(kept * ForearmShare, f) * hinge, amount);
            a.hand.rotation = Quaternion.AngleAxis((kept - handRoll) * amount, f) * handNow;
        }

        /// <summary>keeps the neck and head inside a natural range, so a generated turn never wrings the neck</summary>
        static void LimitJoint(Bone bone)
        {
            var turn = bone.transform.localRotation * Quaternion.Inverse(bone.restLocal);
            turn.ToAngleAxis(out float angle, out var axis);
            if (angle > 180f) { angle = 360f - angle; axis = -axis; }
            if (angle <= bone.knee || axis.sqrMagnitude < 0.5f) return;
            float room = bone.limit - bone.knee;
            float eased = bone.knee + room * (1f - Mathf.Exp(-(angle - bone.knee) / room));
            bone.transform.localRotation = Quaternion.AngleAxis(eased, axis) * bone.restLocal;
        }

        void LimitArmBack(ArmChain a, float w)
        {
            if (a == null) return;
            var carried = Carried(a);
            var along = Quaternion.Inverse(carried) * (a.lower.position - a.upper.position);
            if (along.y >= 0f) return;
            float angle = Mathf.Atan2(along.z, -along.y) * Mathf.Rad2Deg;
            float knee = running ? RunBackKnee : BackKnee, limit = running ? RunBackLimit : BackLimit;
            if (angle >= knee) return;
            float room = knee - limit;
            float eased = knee - room * (1f - Mathf.Exp(-(knee - angle) / room));
            var right = carried * Vector3.right;
            // (about the body's right, a negative turn takes the arm forward)
            a.upper.rotation = Quaternion.AngleAxis((angle - eased) * w, right) * a.upper.rotation;
        }

        /// <summary>the arms swing front to back in turn around where they hang, with the chest turning a little against them</summary>
        void SwingArms(float w, float dt)
        {
            swingAmount = Mathf.MoveTowards(swingAmount, Time.time < swingUntil ? 1f : 0f, dt / SwingEase);
            if (swingAmount <= 0f)
            {
                swingPhase = 0f;
                return;
            }
            swingPhase += dt * Mathf.PI * 2f / SwingSeconds;
            float s = Mathf.Sin(swingPhase) * Mathf.SmoothStep(0f, 1f, swingAmount) * w;
            if (spine) spine.rotation = Quaternion.AngleAxis(s * SwingChest, root.up) * spine.rotation;
            SwingArm(leftArm, s);
            SwingArm(rightArm, -s);
        }

        void SwingArm(ArmChain a, float forward)
        {
            if (a == null) return;
            // (about the character's right, a negative turn takes a hanging arm forward)
            a.upper.rotation = Quaternion.AngleAxis(-forward * SwingAngle, root.right) * a.upper.rotation;
            a.lower.rotation = Quaternion.AngleAxis(-Mathf.Max(0f, forward) * SwingElbow, root.right) * a.lower.rotation;
        }

        void TurnHead(float w, float dt)
        {
            if (Time.time >= headTurnUntil) headTurnGoal = 0f;
            headTurn = Mathf.SmoothDamp(headTurn, headTurnGoal, ref headTurnSpeed, HeadTurnSeconds, Mathf.Infinity, dt);
            if (Mathf.Abs(headTurn) < 0.01f || !neck || !headBone) return;
            neck.rotation = Quaternion.AngleAxis(headTurn * NeckTurnShare * w, root.up) * neck.rotation;
            headBone.rotation = Quaternion.AngleAxis(headTurn * (1f - NeckTurnShare) * w, root.up) * headBone.rotation;
        }

        /// <summary>takes the slow lean out of the torso, turning it at the spine toward its T-pose direction</summary>
        void KeepUpright(float w, float settle)
        {
            if (!spine || !neck) return;
            var now = Quaternion.Inverse(root.rotation) * (neck.position - hips.position);
            var fix = Quaternion.FromToRotation(now, torsoRest);
            if (!balanced) upright = fix;
            else if (prompt == IdlePrompt) upright = Quaternion.Slerp(upright, fix, settle);
            var turn = root.rotation * Quaternion.Slerp(Quaternion.identity, upright, w) * Quaternion.Inverse(root.rotation);
            spine.rotation = turn * spine.rotation;
        }

        /// <summary>the feet stay where they stand: the hips come down if a leg cannot reach, and each leg is solved to its foot</summary>
        void PlantFeet(float w)
        {
            if (!leftFoot || !rightFoot || !leftUpperLeg || !rightUpperLeg || !leftLowerLeg || !rightLowerLeg) return;
            var leftGoal = root.TransformPoint(leftPlant);
            var rightGoal = root.TransformPoint(rightPlant);
            float drop = Mathf.Max(DropFor(leftUpperLeg, leftLowerLeg, leftFoot, leftGoal), DropFor(rightUpperLeg, rightLowerLeg, rightFoot, rightGoal));
            if (drop > 0f) hips.position += Vector3.down * (drop * w);
            SolveLeg(leftUpperLeg, leftLowerLeg, leftFoot, leftGoal, root.rotation * leftFootRest, w);
            SolveLeg(rightUpperLeg, rightLowerLeg, rightFoot, rightGoal, root.rotation * rightFootRest, w);
        }

        /// <summary>takes a hand to what it is holding, with the elbow out and down</summary>
        void ReachHand(Transform upper, Transform lower, Transform hand, Vector3 goal, float reach, float side)
        {
            if (reach <= 0f || !upper || !lower || !hand) return;
            var shoulder = upper.position;
            var elbow = lower.position;
            var wrist = hand.position;
            var handRotation = hand.rotation;
            var target = Vector3.Lerp(wrist, goal, reach);
            float a = (elbow - shoulder).magnitude, b = (wrist - elbow).magnitude;
            var toTarget = target - shoulder;
            float d = Mathf.Clamp(toTarget.magnitude, Mathf.Abs(a - b) + 0.001f, a + b - 0.001f);
            var dir = toTarget.normalized;
            var pole = Vector3.ProjectOnPlane(elbow - (shoulder + wrist) * 0.5f + root.right * (side * 0.12f) + Vector3.down * 0.06f, dir).normalized;
            float along = (a * a - b * b + d * d) / (2f * d);
            var newElbow = shoulder + dir * along + pole * Mathf.Sqrt(Mathf.Max(0f, a * a - along * along));
            upper.rotation = Quaternion.FromToRotation(elbow - shoulder, newElbow - shoulder) * upper.rotation;
            lower.rotation = Quaternion.FromToRotation(hand.position - lower.position, shoulder + dir * d - lower.position) * lower.rotation;
            hand.rotation = handRotation;
        }

        static float DropFor(Transform upper, Transform lower, Transform foot, Vector3 goal)
        {
            float reach = (Vector3.Distance(upper.position, lower.position) + Vector3.Distance(lower.position, foot.position)) * LegReach;
            var d = upper.position - goal;
            float across = new Vector2(d.x, d.z).magnitude;
            return across >= reach ? 0f : d.y - Mathf.Sqrt(reach * reach - across * across);
        }

        void SolveLeg(Transform upper, Transform lower, Transform foot, Vector3 goal, Quaternion footRotation, float w)
        {
            var hip = upper.position;
            var knee = lower.position;
            var ankle = foot.position;
            var target = Vector3.Lerp(ankle, goal, w);
            float a = (knee - hip).magnitude, b = (ankle - knee).magnitude;
            var toTarget = target - hip;
            float d = Mathf.Clamp(toTarget.magnitude, Mathf.Abs(a - b) + 0.001f, a + b - 0.001f);
            var dir = toTarget.normalized;
            // the knee bends forward, also when the leg is nearly straight
            var pole = Vector3.ProjectOnPlane(knee - (hip + ankle) * 0.5f + root.forward * 0.12f, dir).normalized;
            float along = (a * a - b * b + d * d) / (2f * d);
            var newKnee = hip + dir * along + pole * Mathf.Sqrt(Mathf.Max(0f, a * a - along * along));
            upper.rotation = Quaternion.FromToRotation(knee - hip, newKnee - hip) * upper.rotation;
            lower.rotation = Quaternion.FromToRotation(foot.position - lower.position, hip + dir * d - lower.position) * lower.rotation;
            foot.rotation = Quaternion.Slerp(foot.rotation, footRotation, w);
        }

        void Receive()
        {
            while (inbox.TryDequeue(out var message))
            {
                switch (message)
                {
                    case JObject ready:
                        Fit(ready);
                        connected = true;
                        break;
                    case Batch batch when batch.epoch == epoch && batch.boneCount == boneCount:
                        for (int i = 0; i < batch.count; i++)
                        {
                            var frame = new float[stride];
                            Array.Copy(batch.data, i * stride, frame, 0, stride);
                            frames[batch.start + i] = frame;
                        }
                        if (promptSentAt >= 0f)
                        {
                            LastResponse = Time.realtimeSinceStartup - promptSentAt;
                            promptSentAt = -1f;
                        }
                        break;
                    case string:
                        connected = false;
                        streaming = playing = wasMoving = false;
                        prompt = nextGesture = null;
                        frames.Clear();
                        epoch = 0;
                        break;
                }
            }
        }

        /// <summary>fit the stream's skeleton to this avatar: bone directions at rest, and leg length for the hips' travel</summary>
        void Fit(JObject ready)
        {
            fps = (int)ready["fps"];
            gestures = ready["prompts"].Select(x => (string)x).Where(x => x != IdlePrompt && x != RelaxPrompt && !x.StartsWith("motion_")).Concat(HeadTurns.Keys).Append(SwingGesture).ToArray();
            hipsHeight = (float)ready["rest"]["hipsHeight"];
            var positions = (JObject)ready["rest"]["positions"];
            Vector3 Soma(HumanBodyBones b)
            {
                var p = (JArray)positions[b.ToString()];
                return new Vector3((float)p[0], (float)p[1], (float)p[2]);
            }

            var names = ready["bones"].Select(x => (string)x).ToArray();
            boneCount = names.Length;
            stride = FrameHead + boneCount * 4;
            bones.Clear();
            var fits = new Dictionary<HumanBodyBones, Quaternion>();
            for (int i = 0; i < names.Length; i++)
            {
                if (!Enum.TryParse(names[i], out HumanBodyBones b) || !rest.TryGetValue(b, out var own)) continue;
                var fit = Quaternion.identity;
                if (Next.TryGetValue(b, out var chain))
                {
                    foreach (var to in chain)
                    {
                        if (!rest.TryGetValue(to, out var child)) continue;
                        var mine = root.rotation * (child.position - own.position);
                        fit = Quaternion.FromToRotation(mine.normalized, (Soma(to) - Soma(b)).normalized);
                        break;
                    }
                }
                else if (SameFitAs.TryGetValue(b, out var other) && fits.TryGetValue(other, out var otherFit)) fit = otherFit;
                fits[b] = fit;
                bones.Add(new Bone
                {
                    transform = anim.GetBoneTransform(b),
                    rest = fit * own.rotation,
                    restLocal = restLocal[b],
                    index = i,
                    shoulder = b is HumanBodyBones.LeftShoulder or HumanBodyBones.RightShoulder,
                    spine = b is HumanBodyBones.Spine or HumanBodyBones.Chest or HumanBodyBones.UpperChest or HumanBodyBones.Neck or HumanBodyBones.Head,
                    knee = b == HumanBodyBones.Neck ? NeckKnee : b == HumanBodyBones.Head ? HeadKnee : 0f,
                    limit = b == HumanBodyBones.Neck ? NeckLimit : b == HumanBodyBones.Head ? HeadLimit : 0f,
                    foot = b is HumanBodyBones.LeftFoot or HumanBodyBones.RightFoot or HumanBodyBones.LeftToes or HumanBodyBones.RightToes,
                });
            }

            float Leg(Func<HumanBodyBones, Vector3> at) =>
                Vector3.Distance(at(HumanBodyBones.LeftUpperLeg), at(HumanBodyBones.LeftLowerLeg))
                + Vector3.Distance(at(HumanBodyBones.LeftLowerLeg), at(HumanBodyBones.LeftFoot));
            scale = Leg(b => rest[b].position) / Mathf.Max(0.01f, Leg(Soma));
        }

        void Send(JObject message)
        {
            outbox.Enqueue(message.ToString(Newtonsoft.Json.Formatting.None));
            outboxSignal.Release();
        }

        // ------------------------------------------------------------------ the socket (on a worker thread)

        async Task Run()
        {
            var token = stop.Token;
            while (!token.IsCancellationRequested)
            {
                using var ws = new ClientWebSocket();
                using var session = CancellationTokenSource.CreateLinkedTokenSource(token);
                bool opened = false;
                try
                {
                    using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(token))
                    {
                        timeout.CancelAfter(2000);
                        await ws.ConnectAsync(new Uri(url), timeout.Token);
                    }
                    opened = true;
                    while (outbox.TryDequeue(out _)) { }
                    var sending = SendLoop(ws, session.Token);
                    await ReceiveLoop(ws, session.Token);
                    session.Cancel();
                    await sending;
                }
                catch (OperationCanceledException) { }
                catch (WebSocketException) { }
                catch (IOException) { }
                if (opened) inbox.Enqueue("closed");
                try { await Task.Delay(5000, token); }
                catch (OperationCanceledException) { return; }
            }
        }

        async Task SendLoop(ClientWebSocket ws, CancellationToken token)
        {
            try
            {
                while (ws.State == WebSocketState.Open)
                {
                    await outboxSignal.WaitAsync(token);
                    while (outbox.TryDequeue(out var text))
                        await ws.SendAsync(new ArraySegment<byte>(Encoding.UTF8.GetBytes(text)), WebSocketMessageType.Text, true, token);
                }
            }
            catch (OperationCanceledException) { }
            catch (WebSocketException) { }
        }

        async Task ReceiveLoop(ClientWebSocket ws, CancellationToken token)
        {
            var buffer = new byte[1 << 16];
            using var message = new MemoryStream();
            while (ws.State == WebSocketState.Open)
            {
                message.SetLength(0);
                WebSocketReceiveResult part;
                do
                {
                    part = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), token);
                    if (part.MessageType == WebSocketMessageType.Close) return;
                    message.Write(buffer, 0, part.Count);
                } while (!part.EndOfMessage);

                if (part.MessageType == WebSocketMessageType.Text)
                {
                    inbox.Enqueue(JObject.Parse(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length)));
                    continue;
                }
                var bytes = message.GetBuffer();
                if (message.Length < 16) continue;
                var batch = new Batch
                {
                    start = BitConverter.ToInt32(bytes, 0),
                    count = BitConverter.ToInt32(bytes, 4),
                    boneCount = BitConverter.ToInt32(bytes, 8),
                    epoch = BitConverter.ToInt32(bytes, 12),
                };
                int floats = batch.count * (FrameHead + batch.boneCount * 4);
                if (message.Length != 16 + floats * 4) continue;
                batch.data = new float[floats];
                Buffer.BlockCopy(bytes, 16, batch.data, 0, floats * 4);
                inbox.Enqueue(batch);
            }
        }

        public void Dispose()
        {
            stop.Cancel();
        }
    }
}

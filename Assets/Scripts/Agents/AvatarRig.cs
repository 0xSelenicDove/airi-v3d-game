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

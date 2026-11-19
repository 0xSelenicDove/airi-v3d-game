using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A part that swings on a hinge (a door leaf, a fridge door, a laptop lid). It is a real rigid body on a
    /// HingeJoint, so it has weight: it speeds up and slows down, overshoots a little and settles, and it stops
    /// against people and furniture instead of passing through them.
    ///
    /// Characters do not set its angle. They move a target slowly (<see cref="Push"/>), the way a hand pushes, and a
    /// spring pulls the part after it. Near the closed position a stronger spring takes over, like a latch or the
    /// magnetic seal of a fridge.
    /// </summary>
    [RequireComponent(typeof(HingeJoint))]
    public class Hinged : MonoBehaviour
    {
        [Tooltip("fully open angle, in degrees (negative to open the other way)")]
        public float openAngle = 95f;
        [Tooltip("spring that follows the hand (N·m per radian, scaled by the mass)")]
        public float spring = 40f;
        public float damper = 8f;
        [Tooltip("below this angle the latch spring pulls it shut")]
        public float latchAngle = 6f;
        public float latchSpring = 160f;
        [Tooltip("the handle, where a hand takes hold; children of the part")]
        public Transform handleFront, handleBack;
        [Tooltip("switched on while open (a fridge light, a laptop screen)")]
        public GameObject onWhileOpen;

        HingeJoint joint;
        Rigidbody body;
        float target;           // where the hand is taking it (degrees)
        float pushTo, pushSpeed;

        /// <summary>the current angle, in degrees, from closed (0) toward <see cref="openAngle"/></summary>
        public float Angle
        {
            get
            {
                // PhysX can report NaN for a resting joint at exactly its closed angle; that is closed
                float a = joint ? joint.angle : 0f;
                return float.IsNaN(a) ? 0f : a;
            }
        }
        /// <summary>0 closed .. 1 fully open</summary>
        public float Openness => Mathf.Clamp01(Angle / openAngle);
        public bool IsClosed => Mathf.Abs(Angle) < 1.5f && Mathf.Abs(pushTo) < 0.01f;
        /// <summary>someone holds it (one person uses a door at a time)</summary>
        public Object Holder { get; private set; }

        void Awake()
        {
            joint = GetComponent<HingeJoint>();
            body = GetComponent<Rigidbody>();
            body.interpolation = RigidbodyInterpolation.Interpolate;
            body.collisionDetectionMode = CollisionDetectionMode.ContinuousDynamic;
            body.maxAngularVelocity = 6f;
            var lim = joint.limits;
            lim.min = Mathf.Min(0, openAngle) - 1f;
            lim.max = Mathf.Max(0, openAngle) + 1f;
            lim.bounciness = 0.1f;
            joint.limits = lim;
            joint.useLimits = true;
            joint.useSpring = true;
            if (onWhileOpen) onWhileOpen.SetActive(false);
            // it closes onto its own frame or cabinet: the joint's limits keep it there, so they need not collide
            var own = GetComponentsInChildren<Collider>();
            if (transform.parent)
                foreach (var other in transform.parent.GetComponentsInChildren<Collider>())
                    if (other.attachedRigidbody != body)
                        foreach (var c in own) Physics.IgnoreCollision(c, other, true);
        }

        public bool TryHold(Object who)
        {
            if (Holder != null && Holder != who) return false;
            Holder = who;
            return true;
        }

        public void Release(Object who)
        {
            if (Holder == who) Holder = null;
        }

        /// <summary>move the hand toward an openness (0..1) at this many degrees per second</summary>
        public void Push(float openness, float degreesPerSecond = 40f)
        {
            pushTo = Mathf.Clamp01(openness) * openAngle;
            pushSpeed = degreesPerSecond;
        }

        /// <summary>the hand point on this side of the part (the side facing <paramref name="from"/>)</summary>
        public Transform HandleFacing(Vector3 from)
        {
            if (!handleBack) return handleFront;
            if (!handleFront) return handleBack;
            return (from - handleFront.position).sqrMagnitude < (from - handleBack.position).sqrMagnitude ? handleFront : handleBack;
        }

        void FixedUpdate()
        {
            target = Mathf.MoveTowards(target, pushTo, pushSpeed * Time.fixedDeltaTime);
            var sp = joint.spring;
            bool latching = Mathf.Abs(target) < latchAngle && Mathf.Abs(Angle) < latchAngle * 2f;
            float m = body.mass;
            sp.spring = (latching ? latchSpring : spring) * m;
            sp.damper = damper * m;
            sp.targetPosition = target;
            joint.spring = sp;
            // a sleeping body ignores its joint's spring: wake it while it has somewhere to go
            if (Mathf.Abs(Angle - target) > 0.3f || !Mathf.Approximately(target, pushTo)) body.WakeUp();
            if (onWhileOpen) onWhileOpen.SetActive(Mathf.Abs(Angle) > 4f);
        }
    }
}

using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// A chair at a table that slides out and back in along the floor. It is a kinematic rigid body (doors and
    /// people's colliders still meet it), and it carves the NavMesh where it stands, so walkers go round it whether
    /// it is pushed in or pulled out. Characters move it by its backrest (<see cref="Slide"/>), or sit on it while it
    /// slides in.
    /// </summary>
    [RequireComponent(typeof(Rigidbody))]
    public class SlidingChair : MonoBehaviour
    {
        [Tooltip("where it stands pushed in, and how far it comes out (m) along outDirection")]
        public Vector3 inPosition;
        public Vector3 outDirection = Vector3.back;
        public float outDistance = 0.55f;
        [Tooltip("where hands take the backrest")]
        public Transform gripLeft, gripRight;
        [Tooltip("where the hips go when sitting on it")]
        public Transform seat;

        Rigidbody body;
        float t, target, speed = 0.5f;

        /// <summary>0 pushed in .. 1 pulled out</summary>
        public float Out => t;
        public bool Moving => !Mathf.Approximately(t, target);
        public Vector3 GripCentre => (gripLeft.position + gripRight.position) * 0.5f;

        void Awake()
        {
            body = GetComponent<Rigidbody>();
            body.isKinematic = true;
            body.interpolation = RigidbodyInterpolation.Interpolate;
            inPosition = transform.position;
        }

        /// <summary>slide toward pulled out (1) or pushed in (0) at this many metres per second</summary>
        public void Slide(float to, float metersPerSecond = 0.45f)
        {
            target = Mathf.Clamp01(to);
            speed = metersPerSecond / Mathf.Max(outDistance, 0.01f);
        }

        void FixedUpdate()
        {
            if (!Moving) return;
            t = Mathf.MoveTowards(t, target, speed * Time.fixedDeltaTime);
            // ease at both ends, like a hand starting and stopping it
            float k = Mathf.SmoothStep(0, 1, t);
            body.MovePosition(inPosition + outDirection.normalized * (outDistance * k));
        }
    }
}

using UnityEngine;
using UnityEngine.InputSystem;

namespace AiWorld.UI
{
    /// <summary>Drag to orbit, right-drag to pan, scroll to zoom, F to follow the characters in turn, R to reset.</summary>
    public class OrbitCamera : MonoBehaviour
    {
        public Vector3 focus = new(0, 0.8f, -0.5f);
        public float distance = 9.5f, yaw = 20f, pitch = 45f;
        [Tooltip("the camera stays at least this many degrees above the floor")]
        public float minPitch = 25f, maxPitch = 85f;
        public Transform[] followTargets;

        int following = -1;
        Vector3 focus0;
        float distance0, yaw0, pitch0;

        void Start()
        {
            focus0 = focus; distance0 = distance; yaw0 = yaw; pitch0 = pitch;
        }

        void LateUpdate()
        {
            var m = Mouse.current;
            var kb = Keyboard.current;
            if (m != null)
            {
                var d = m.delta.ReadValue();
                if (m.leftButton.isPressed) { yaw += d.x * 0.25f; pitch -= d.y * 0.2f; following = -1; }
                if (m.rightButton.isPressed)
                {
                    var right = transform.right; right.y = 0;
                    var fwd = transform.forward; fwd.y = 0;
                    focus -= (right.normalized * d.x + fwd.normalized * d.y) * 0.01f * distance * 0.2f;
                    following = -1;
                }
                float s = m.scroll.ReadValue().y;
                if (Mathf.Abs(s) > 0.01f) distance = Mathf.Clamp(distance * (1f - Mathf.Sign(s) * 0.1f), 2f, 25f);
            }
            if (kb != null)
            {
                if (kb.fKey.wasPressedThisFrame && followTargets != null && followTargets.Length > 0)
                    following = following + 1 >= followTargets.Length ? -1 : following + 1;
                if (kb.rKey.wasPressedThisFrame) { focus = focus0; distance = distance0; yaw = yaw0; pitch = pitch0; following = -1; }
            }
            if (following >= 0 && followTargets[following])
                focus = Vector3.Lerp(focus, followTargets[following].position + Vector3.up * 1.0f, Time.deltaTime * 3f);
            pitch = Mathf.Clamp(pitch, minPitch, maxPitch);
            var rot = Quaternion.Euler(pitch, yaw, 0);
            transform.SetPositionAndRotation(focus - rot * Vector3.forward * distance, rot);
        }
    }
}

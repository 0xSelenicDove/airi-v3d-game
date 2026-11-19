using UnityEngine;
using UnityEngine.Rendering;

namespace AiWorld.World
{
    /// <summary>A house wall that hides itself (it still casts shadows) when the camera is on its outer side, like a doll's house.</summary>
    public class WallCutaway : MonoBehaviour
    {
        [Tooltip("points out of the house")]
        public Vector3 outward = Vector3.back;
        Renderer[] renderers;

        void Awake() => renderers = GetComponentsInChildren<Renderer>();

        void LateUpdate()
        {
            var cam = Camera.main;
            if (!cam) return;
            bool hide = Vector3.Dot(cam.transform.position - transform.position, outward) > 0.3f;
            var mode = hide ? ShadowCastingMode.ShadowsOnly : ShadowCastingMode.On;
            foreach (var r in renderers) r.shadowCastingMode = mode;
        }
    }
}

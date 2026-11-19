using UnityEngine;

namespace AiWorld.World
{
    /// <summary>A chair at a desk with a laptop on it.</summary>
    public class DeskParts : MonoBehaviour
    {
        [Tooltip("stand here, back to the chair")]
        public Transform front;
        [Tooltip("sitting: position and facing")]
        public Transform seat;
        public float seatTop = 0.48f;
        public Hinged lid;
        public Transform lidEdge;
        public Transform screen;
    }
}

using UnityEngine;

namespace AiWorld.World
{
    /// <summary>A desk with a laptop on it and a chair that slides out from it.</summary>
    public class DeskParts : MonoBehaviour
    {
        public SlidingChair chair;
        [Tooltip("stand here, behind the pushed-in chair, facing the desk, to take its backrest")]
        public Transform behind;
        [Tooltip("beside the pulled-out chair, on the open floor")]
        public Transform side;
        [Tooltip("between the pulled-out chair and the desk, facing the desk: the calves touch the seat")]
        public Transform stepIn;
        public float seatTop = 0.48f;
        public Hinged lid;
        public Transform lidEdge;
        public Transform screen;
    }
}

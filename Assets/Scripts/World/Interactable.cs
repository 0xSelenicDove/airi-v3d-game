using System;
using System.Collections.Generic;
using UnityEngine;

namespace AiWorld.World
{
    public enum Need { Energy, Fun, Knowledge, Hunger }

    public enum Pose { Stand, Sit, Lie }

    /// <summary>what a thing lets you do: "bed → sleep", "laptop → use_computer", "fridge → eat"</summary>
    [Serializable]
    public class Affordance
    {
        public string verb;
        [Tooltip("game minutes the activity takes")]
        public float minutes = 30;
        public Pose pose = Pose.Stand;
        [Tooltip("total change to each need over the activity (index = Need)")]
        public float energy, fun, knowledge, hunger;
        [Tooltip("only from this hour up to (not including) the next; equal = any time. May wrap past midnight.")]
        public int fromHour, toHour;

        public float Effect(Need n) => n switch
        {
            Need.Energy => energy,
            Need.Fun => fun,
            Need.Knowledge => knowledge,
            _ => hunger,
        };

        public bool OpenAt(float hour)
        {
            if (fromHour == toHour) return true;
            return fromHour < toHour ? hour >= fromHour && hour < toHour : hour >= fromHour || hour < toHour;
        }
    }

    /// <summary>
    /// A thing in the world that a character can use. The brain only picks an object and a verb; the object's
    /// <see cref="Routine"/> (on the same GameObject) says how the body does it, step by step.
    /// </summary>
    public class Interactable : MonoBehaviour
    {
        public string id;
        public string kind;
        public List<Affordance> affordances = new();
        [Tooltip("where the character stands before using it (on the NavMesh)")]
        public Transform approach;
        [Tooltip("which side of the house wall it is on: true = inside")]
        public bool inside = true;

        public static readonly List<Interactable> All = new();

        /// <summary>the one person using it (beds, desks and fridges are used by one person at a time)</summary>
        public Agents.Agent User { get; private set; }

        public bool TryClaim(Agents.Agent a)
        {
            if (User != null && User != a) return false;
            User = a;
            return true;
        }

        public void Free(Agents.Agent a)
        {
            if (User == a) User = null;
        }

        void OnEnable() => All.Add(this);
        void OnDisable() => All.Remove(this);
    }
}

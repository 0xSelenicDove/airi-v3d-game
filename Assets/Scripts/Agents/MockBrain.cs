using System.Collections.Generic;
using AiWorld.World;
using UnityEngine;

namespace AiWorld.Agents
{
    public struct Choice
    {
        public Interactable target;
        public Affordance affordance;
        public string reason;
    }

    /// <summary>Decides what to do next. The mock brain below is rule-based; an LLM brain plugs in here later.</summary>
    public interface IBrain
    {
        Choice Choose(Agent self, IReadOnlyList<Interactable> world, float hour);
    }

    /// <summary>
    /// A utility brain: each thing it could do scores by how much it would help the needs that are low, minus the
    /// walk to get there, plus a little randomness so the day does not repeat. Sleep wins at night and when tired.
    /// </summary>
    public class MockBrain : IBrain
    {
        Interactable last;

        public Choice Choose(Agent self, IReadOnlyList<Interactable> world, float hour)
        {
            Choice best = default;
            float bestScore = float.MinValue;
            bool night = hour >= 22 || hour < 6;
            foreach (var it in world)
            {
                if (it.User != null && it.User != self) continue;
                foreach (var a in it.affordances)
                {
                    if (!a.OpenAt(hour)) continue;
                    float s = 0;
                    foreach (Need n in System.Enum.GetValues(typeof(Need)))
                    {
                        float deficit = (100 - self.needs[n]) / 100f;
                        s += a.Effect(n) * deficit * deficit;
                    }
                    if (s < 1.5f && a.verb != "sleep") continue;   // it would not help any need that is low
                    if (a.verb == "sleep") s += night ? 40 : (self.needs[Need.Energy] < 25 ? 15 : -30);
                    if (it == last) s -= 8;   // do something different
                    s -= Vector3.Distance(self.transform.position, it.approach.position) * 0.8f;
                    s += Random.Range(0f, 6f);
                    if (s > bestScore)
                    {
                        bestScore = s;
                        best = new Choice { target = it, affordance = a, reason = Reason(self, a) };
                    }
                }
            }
            last = best.target;
            return best;
        }

        static string Reason(Agent self, Affordance a) => a.verb switch
        {
            "sleep" => "I'm getting sleepy…",
            "eat" => self.needs[Need.Hunger] < 40 ? "I'm hungry. What's in the fridge?" : "Maybe a little snack.",
            "use_computer" => "Let me read something on the computer.",
            "get_air" => "I'd like some fresh air.",
            _ => $"I'll {a.verb.Replace('_', ' ')}.",
        };
    }
}

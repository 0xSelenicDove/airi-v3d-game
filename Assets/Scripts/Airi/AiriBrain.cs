using System;
using System.Collections.Generic;
using AiWorld.Agents;
using AiWorld.World;
using UnityEngine;

namespace AiWorld.Airi
{
    /// <summary>
    /// The brain of the character AIRI plays. While AIRI is connected (through the MCP bridge, see AiriLink), every
    /// decision waits for AIRI's next action: Choose returns no choice, so the agent stands by and asks again. AIRI's
    /// model acts only on its own turns, so when it gives no action for <see cref="autopilotSeconds"/>, the character's
    /// own brain makes that one decision, and AIRI hears about it. Without AIRI, this is the character's own brain.
    /// </summary>
    public class AiriBrain : IBrain
    {
        readonly IBrain own;
        /// <summary>real seconds to wait for AIRI before the own brain decides once; 0 waits for ever</summary>
        public float autopilotSeconds;

        public bool Controlled { get; private set; }
        /// <summary>the character is standing by for AIRI's next action</summary>
        public bool Awaiting => waitingSince >= 0;

        /// <summary>told when the character starts waiting for a decision</summary>
        public event Action OnTurn;
        /// <summary>told when the own brain decided because AIRI gave no action in time</summary>
        public event Action<Choice> OnAutopilot;

        Choice? queued;
        float waitingSince = -1;
        float waitUntilMinutes = -1;

        public AiriBrain(IBrain own, float autopilotSeconds = 60f)
        {
            this.own = own;
            this.autopilotSeconds = autopilotSeconds;
        }

        public Choice Choose(Agent self, IReadOnlyList<Interactable> world, float hour)
        {
            if (!Controlled) return own.Choose(self, world, hour);
            if (queued is Choice c)
            {
                queued = null;
                waitingSince = -1;
                return c;
            }
            // AIRI said to wait: stand by until then without asking her again
            if (GameClock.Instance && GameClock.Instance.Minutes < waitUntilMinutes) return default;
            float now = Time.realtimeSinceStartup;
            if (waitingSince < 0)
            {
                waitingSince = now;
                OnTurn?.Invoke();
            }
            if (autopilotSeconds > 0 && now - waitingSince > autopilotSeconds)
            {
                waitingSince = -1;
                var mine = own.Choose(self, world, hour);
                OnAutopilot?.Invoke(mine);
                return mine;
            }
            return default;
        }

        /// <summary>AIRI connected or left; leaving gives the decisions back to the own brain at once</summary>
        public void SetControl(bool on)
        {
            Controlled = on;
            queued = null;
            waitingSince = -1;
            waitUntilMinutes = -1;
        }

        /// <summary>AIRI's next thing to do: taken at the next decision (within 2 s while the character stands by)</summary>
        public void Queue(Choice c)
        {
            queued = c;
            waitUntilMinutes = -1;
        }

        /// <summary>AIRI wants to stay put for some game minutes</summary>
        public void WaitFor(float minutes)
        {
            queued = null;
            waitingSince = -1;
            waitUntilMinutes = (GameClock.Instance ? GameClock.Instance.Minutes : 0) + minutes;
        }
    }
}

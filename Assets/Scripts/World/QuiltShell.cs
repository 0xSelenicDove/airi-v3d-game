using System.Collections.Generic;
using UnityEngine;

namespace AiWorld.World
{
    /// <summary>
    /// Draws a cloth sheet as a thick, quilted duvet. The cloth simulates one layer of vertices (cloth needs that);
    /// this builds a closed shell around it every frame: a puffy top that dips at the stitch lines, a flat underside,
    /// and a rounded rim joining them along the border. The cloth's own renderer is switched off.
    /// Put it on a child of the cloth with an identity local transform.
    /// </summary>
    [RequireComponent(typeof(MeshFilter), typeof(MeshRenderer))]
    public class QuiltShell : MonoBehaviour
    {
        public Cloth cloth;
        [Tooltip("while the quilt lies still, the shell is not rebuilt: the cloth's tiny settling moves do not show as a shiver")]
        public SoftBlanket blanket;
        [Tooltip("the sheet is a grid of this many columns (across) and rows (along); its uv runs 0..1 over it")]
        public int cols = 16, rows = 24;
        [Tooltip("how far the top puffs up over the cloth in the middle of a square, and at a stitch line (m)")]
        public float puff = 0.045f, stitch = 0.018f;
        [Tooltip("how far the underside lies under the cloth (m)")]
        public float under = 0.012f;
        /// <summary>grid steps per quilted square along each axis (the cover texture draws its stitch lines here too)</summary>
        public const int Square = 4;

        Mesh mesh;
        int n;
        bool built;
        float[] lift;          // per cloth vertex: how far the top stands over it
        int[] rim;             // border vertex loop
        int[] inner;           // for each border vertex, a neighbour inside the sheet (the roll bulges away from it)
        Vector3[] pos;
        Vector2[] uv;

        void Start()
        {
            var smr = cloth.GetComponent<SkinnedMeshRenderer>();
            smr.forceRenderingOff = true;
            var src = smr.sharedMesh;
            n = src.vertexCount;
            var rest = src.vertices;
            var tris = src.triangles;

            var srcUv = src.uv;
            lift = new float[n];
            uv = new Vector2[n * 2];
            for (int i = 0; i < n; i++)
            {
                float u = srcUv[i].x, w = srcUv[i].y;
                float ci = u * (cols - 1), ri = w * (rows - 1);
                // puffy in the middle of each square, down at the stitch lines; the edges roll down into the rim
                float sx = Mathf.Abs(Mathf.Sin(Mathf.PI * ci / Square)), sy = Mathf.Abs(Mathf.Sin(Mathf.PI * ri / Square));
                float pillow = Mathf.Sqrt(sx * sy);
                float edge = Mathf.Min(Mathf.Min(ci, cols - 1 - ci), Mathf.Min(ri, rows - 1 - ri));
                float roll = Mathf.SmoothStep(0.35f, 1f, Mathf.Clamp01(edge / 1.5f));
                lift[i] = Mathf.Lerp(stitch, puff, pillow) * roll + 0.006f;
                uv[i] = new Vector2(u, w);
                uv[n + i] = new Vector2(u, w);
            }

            // the border loop, from the edges used by one triangle only
            var count = new Dictionary<(int, int), int>();
            var next = new Dictionary<int, int>();
            for (int t = 0; t < tris.Length; t += 3)
            for (int k = 0; k < 3; k++)
            {
                int a = tris[t + k], c = tris[t + (k + 1) % 3];
                var key = a < c ? (a, c) : (c, a);
                count[key] = count.TryGetValue(key, out var m) ? m + 1 : 1;
            }
            for (int t = 0; t < tris.Length; t += 3)
            for (int k = 0; k < 3; k++)
            {
                int a = tris[t + k], c = tris[t + (k + 1) % 3];
                if (count[a < c ? (a, c) : (c, a)] == 1) next[a] = c;
            }
            var loop = new List<int>();
            if (next.Count > 0)
            {
                int start = 0;
                foreach (var kv in next) { start = kv.Key; break; }
                int cur = start;
                do { loop.Add(cur); cur = next[cur]; } while (cur != start && loop.Count <= next.Count);
            }
            rim = loop.ToArray();
            var onRim = new HashSet<int>(rim);
            var near = new Dictionary<int, int>();
            for (int t = 0; t < tris.Length; t += 3)
            for (int k = 0; k < 3; k++)
            {
                int a = tris[t + k];
                if (!onRim.Contains(a) || near.ContainsKey(a)) continue;
                for (int j = 1; j < 3; j++)
                {
                    int c = tris[t + (k + j) % 3];
                    if (!onRim.Contains(c)) { near[a] = c; break; }
                }
            }
            inner = new int[rim.Length];
            for (int r = 0; r < rim.Length; r++)
            {
                // a corner touches only border vertices along its edges: take the one diagonally inside instead
                if (!near.TryGetValue(rim[r], out inner[r]))
                    inner[r] = near.TryGetValue(rim[(r + 1) % rim.Length], out var x) ? x : rim[(r + rim.Length / 2) % rim.Length];
            }

            // vertices: top [0, n), underside [n, 2n), rim: 4 per border vertex (top, upper, lower, bottom of the roll)
            int rimStart = 2 * n;
            int total = rimStart + rim.Length * 4;
            pos = new Vector3[total];
            var uvAll = new Vector2[total];
            System.Array.Copy(uv, uvAll, 2 * n);
            for (int r = 0; r < rim.Length; r++)
                for (int k = 0; k < 4; k++) uvAll[rimStart + r * 4 + k] = uv[rim[r]];

            var idx = new List<int>(tris.Length * 2 + rim.Length * 18);
            idx.AddRange(tris);
            for (int t = 0; t < tris.Length; t += 3) { idx.Add(n + tris[t]); idx.Add(n + tris[t + 2]); idx.Add(n + tris[t + 1]); }
            for (int r = 0; r < rim.Length; r++)
            {
                int a = rimStart + r * 4, c = rimStart + ((r + 1) % rim.Length) * 4;
                for (int k = 0; k < 3; k++)
                {
                    idx.Add(a + k); idx.Add(c + k); idx.Add(c + k + 1);
                    idx.Add(a + k); idx.Add(c + k + 1); idx.Add(a + k + 1);
                }
            }

            // the top must face the way the cloth's normals do (they come from the same mesh's normals)
            var restNormals = src.normals;
            int topEnd = tris.Length * 2;
            if (Vector3.Dot(Normal(src, 0), restNormals[tris[0]]) < 0) Flip(idx, 0, topEnd);
            // and the rim must face out, away from the sheet
            Fill(rest, restNormals);
            if (rim.Length > 1)
            {
                var a = pos[idx[topEnd]];
                var faceN = Vector3.Cross(pos[idx[topEnd + 1]] - a, pos[idx[topEnd + 2]] - a);
                if (Vector3.Dot(faceN, rest[rim[0]] - rest[inner[0]]) < 0) Flip(idx, topEnd, idx.Count);
            }

            mesh = new Mesh { name = "Quilt" };
            mesh.MarkDynamic();
            mesh.vertices = pos;
            mesh.uv = uvAll;
            mesh.SetIndices(idx, MeshTopology.Triangles, 0);
            GetComponent<MeshFilter>().sharedMesh = mesh;
            LateUpdate();
        }

        static Vector3 Normal(Mesh m, int tri)
        {
            var v = m.vertices;
            var t = m.triangles;
            return Vector3.Cross(v[t[tri * 3 + 1]] - v[t[tri * 3]], v[t[tri * 3 + 2]] - v[t[tri * 3]]).normalized;
        }

        static void Flip(List<int> idx, int from, int to)
        {
            for (int i = from; i < to; i += 3) (idx[i + 1], idx[i + 2]) = (idx[i + 2], idx[i + 1]);
        }

        void LateUpdate()
        {
            if (!mesh || !cloth) return;
            var v = cloth.vertices;
            var nr = cloth.normals;
            if (v.Length != n || nr.Length != n) return;
            if (built && blanket && blanket.Still) return;
            built = true;
            Fill(v, nr);
            mesh.vertices = pos;
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
        }

        void Fill(Vector3[] v, Vector3[] nr)
        {
            for (int i = 0; i < n; i++)
            {
                var up = nr[i];
                pos[i] = v[i] + up * lift[i];
                pos[n + i] = v[i] - up * under;
            }
            int rimStart = 2 * n;
            for (int r = 0; r < rim.Length; r++)
            {
                int i = rim[r];
                var up = nr[i];
                // push the roll out past the border a little, so the edge is round, not a cut
                int prev = rim[(r + rim.Length - 1) % rim.Length], nxt = rim[(r + 1) % rim.Length];
                var tangent = (v[nxt] - v[prev]).normalized;
                var outward = Vector3.Cross(tangent, up).normalized;
                if (Vector3.Dot(outward, v[i] - v[inner[r]]) < 0) outward = -outward;
                float top = lift[i], bot = under, mid = (top - bot) * 0.5f, bulge = (top + bot) * 0.45f;
                pos[rimStart + r * 4 + 0] = v[i] + up * top;
                pos[rimStart + r * 4 + 1] = v[i] + up * (mid + (top - mid) * 0.55f) + outward * bulge * 0.8f;
                pos[rimStart + r * 4 + 2] = v[i] + up * (mid - (mid + bot) * 0.55f) + outward * bulge * 0.8f;
                pos[rimStart + r * 4 + 3] = v[i] - up * bot;
            }
        }
    }
}

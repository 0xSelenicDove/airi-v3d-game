using UnityEditor;
using UnityEngine;

namespace AiWorld.EditorTools
{
    /// <summary>Entry points for the command line: Unity -batchmode -executeMethod AiWorld.EditorTools.BatchTools.X</summary>
    public static class BatchTools
    {
        /// <summary>Import the models again: the first import of a fresh project runs before the VRM shaders exist.</summary>
        public static void ReimportModels()
        {
            foreach (var dir in new[] { "Assets/Avatars", "Assets/Art" })
            {
                foreach (var guid in AssetDatabase.FindAssets("", new[] { dir }))
                {
                    var path = AssetDatabase.GUIDToAssetPath(guid);
                    if (path.EndsWith(".vrm") || path.EndsWith(".glb"))
                    {
                        AssetDatabase.ImportAsset(path, ImportAssetOptions.ForceUpdate);
                        var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                        Debug.Log($"[BatchTools] {path}: {(go ? "ok" : "FAILED")}");
                    }
                }
            }
        }
    
        /// <summary>Build the room scene (SliceSceneBuilder) from the command line.</summary>
        public static void BuildScene()
        {
            ReimportModels();
            SliceSceneBuilder.Build();
        }
    }
}

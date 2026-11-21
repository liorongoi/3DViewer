-- Gaussian splat models (docs/GAUSSIAN_SPLATS.md): SPZ and splat PLY uploads, drawn as 3D Tiles.
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_source_format_check;

ALTER TABLE models ADD CONSTRAINT models_source_format_check CHECK (source_format IN ('glb', 'gltf', 'fbx', '3dtiles', 'spz', 'ply'));

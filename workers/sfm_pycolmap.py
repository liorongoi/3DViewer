#!/usr/bin/env python3
"""Camera poses with pycolmap, for a server without the colmap program (holo-splat-worker.mjs).

Writes <work>/sparse/<n> and an undistorted dataset in <work>/data (images/ and sparse/), the
same layout `colmap image_undistorter` makes. Exit 2 when the pictures give no reconstruction.
"""
import argparse
import os
import shutil
import sys

import pycolmap


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--matcher", choices=["sequential", "exhaustive", "vocabtree"], default="exhaustive")
    ap.add_argument("--vocab-tree", default="")
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    db = os.path.join(a.work, "colmap.db")
    sparse = os.path.join(a.work, "sparse")
    os.makedirs(sparse, exist_ok=True)

    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = "OPENCV"
    extraction = pycolmap.FeatureExtractionOptions()
    extraction.num_threads = a.threads
    pycolmap.extract_features(db, a.images, camera_mode=pycolmap.CameraMode.SINGLE if a.matcher == "sequential" else pycolmap.CameraMode.AUTO, reader_options=reader, extraction_options=extraction)
    print("progress 0.12 features", flush=True)
    if a.matcher == "sequential":
        pairing = pycolmap.SequentialPairingOptions()
        pairing.overlap = 15
        pycolmap.match_sequential(db, pairing_options=pairing)
    elif a.matcher == "vocabtree" and a.vocab_tree:
        pairing = pycolmap.VocabTreePairingOptions()
        pairing.vocab_tree_path = a.vocab_tree
        pycolmap.match_vocabtree(db, pairing_options=pairing)
    else:
        pycolmap.match_exhaustive(db)
    print("progress 0.2 matching", flush=True)
    opts = pycolmap.IncrementalPipelineOptions()
    opts.num_threads = a.threads
    models = pycolmap.incremental_mapping(db, a.images, sparse, options=opts)
    print("progress 0.28 poses", flush=True)
    if not models:
        print("No camera poses could be found: the pictures do not overlap enough, or are too blurred or too plain.", file=sys.stderr)
        return 2
    # The largest model is the one to keep. Read them back from disk: the folder numbers pycolmap
    # writes need not match the keys of the models it returns.
    folders = [os.path.join(sparse, d) for d in os.listdir(sparse) if os.path.exists(os.path.join(sparse, d, "images.bin"))]
    best = max(folders, key=lambda d: pycolmap.Reconstruction(d).num_reg_images())
    data = os.path.join(a.work, "data")
    shutil.rmtree(data, ignore_errors=True)
    pycolmap.undistort_images(data, best, a.images, output_type="COLMAP")
    return 0


if __name__ == "__main__":
    sys.exit(main())

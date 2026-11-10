# Background-removal models

These ONNX files are copied here at build time by `scripts/fetch-rembg-models.js`
from the rembg model release (https://github.com/danielgatis/rembg/releases/tag/v0.0.0),
and checked against rembg's md5 sums. They are not stored in git.

| File | Model | Source | License |
| --- | --- | --- | --- |
| `u2netp.onnx` | U²-Net (small) | https://github.com/xuebinqin/U-2-Net | Apache License 2.0 |
| `isnet-general-use.onnx` | IS-Net (general use) | https://github.com/xuebinqin/DIS | Apache License 2.0 |

The image pre- and post-processing in `src/background/rembgCore.js` is ported
from rembg, Copyright (c) 2020 Daniel Gatis, MIT License.

Apache License 2.0: https://www.apache.org/licenses/LICENSE-2.0

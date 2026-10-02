# Third-party notices

## Local image safety assets

DCFilter includes the following assets for local inference. The model and runtime
are bundled; inference does not require a model server or API key. Images selected
for analysis are fetched from permitted DCInside image hosts, then processed in
the extension. Neither image pixels nor analysis results are sent to a model/API
provider. This describes the analysis path: feature settings, block lists and
user-entered comment examples use the browser's sync storage and may be synced by
the browser provider according to the user's account and sync settings.

| Component | Pinned source | License |
| --- | --- | --- |
| CLIP ViT-B/32 quantized vision model | [Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32/tree/d15189d7028b43f1d3e65039190477f6af591c2a), revision `d15189d7028b43f1d3e65039190477f6af591c2a` | MIT, `models/clip-vit-base-patch32/LICENSE.txt` |
| CLIP pretrained model and tokenizer | [OpenAI CLIP](https://github.com/openai/CLIP/tree/a1d071733d7111c9c014f024669f959182114e33) | MIT, same bundled license |
| ONNX Runtime Web 1.20.1 | [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime/tree/v1.20.1) | MIT, `vendor/onnxruntime-web/LICENSE`, plus `ThirdPartyNotices.txt` |

`safety-prompts.json` contains normalized CLIP text embeddings computed locally
from 41 fixed English prompts by `scripts/prepare-safety-model.py`. Only the vision
weights, prompt vectors and browser inference runtime are shipped; the text model
and tokenizer used during preparation are not included in the installable ZIP.
The script requires Python, NumPy and ONNX Runtime. The packaged SHA-256 inventory
is `models/clip-vit-base-patch32/asset-integrity.json`.

This is an experimental zero-shot similarity filter, not a trained or validated
gore/sexual-content classifier. Its scores are relative similarities, not calibrated
probabilities. It can miss disturbing or explicit imagery and can hide ordinary
images. Unsupported formats, animation, incomplete or failed inspections, and
images beyond the size limits remain covered, as do classifications flagged as
harmful. Since version 0.6.2, a still image whose inspection completed but whose
classification is ambiguous is displayed by default. Enabling the setting to hide
ambiguous images restores coverage for those completed, uncertain classifications.
That setting does not reveal unsupported media or failed inspections. Displaying
an uncertain classification is not a safe-content verdict. The full image and overlapping
square crops of long images are inspected, but small details may still be missed.
CLIP uses 224px inputs; canvas resampling is used in the browser. This filter is a
viewing aid, not a guarantee that displayed images are safe.

In an earlier browser smoke check, before the default display policy changed in
0.6.2, a public car photo passed strict mode while a public photo of two sleeping
cats on a red sofa was classified as uncertain and remained covered. This is a
historical example of overblocking, not a claim that the current default hides
that image. A completed uncertain result is now shown by default unless the user
opts to hide it or another filter hides the image. Smoke checks verify execution
and handling of specific cases; they do not establish detection accuracy or recall.

## Local IP prefix tables

`src/content.js` includes derived, compressed address-prefix tables. The dates below
are the snapshot dates recorded in the source; these tables do not update online.

- **APNIC delegated statistics**: [delegated-apnic-latest](https://ftp.apnic.net/stats/apnic/delegated-apnic-latest),
  snapshot dated 2026-07-23. Korean IPv4 allocations were summarized into `/16`
  prefixes for use with the shortened addresses displayed by DCInside. APNIC makes
  the statistics available for download and use on the condition that APNIC is not
  held responsible for resulting loss or damage. APNIC does not guarantee their
  accuracy; allocation-country records are not authoritative current geolocation.
- **IPtoASN**, maintained by Frank Denis: [IPtoASN IPv4-to-ASN database](https://iptoasn.com/),
  snapshot dated 2026-07-24, provided under the [Public Domain Dedication and License
  (PDDL) v1.0](https://opendatacommons.org/licenses/pddl/1-0/).
  Korean ISP ranges were aggregated to `/16` blocks using majority and coverage
  thresholds. Country estimates use dominant `/8` countries with selected `/16`
  exceptions. The source dataset and the derived summaries can be incomplete or
  outdated. These labels are estimates, not proof of a user's location or identity.

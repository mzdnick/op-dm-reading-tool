# Driver face overlay compatibility

The green and orange boxes are visualizations of `driverStateV2.DriverData.facePosition`. They are not face detections or privacy-redaction boxes. Their placement has three independent inputs that must not be collapsed into a single openpilot version check:

1. the DM model's output convention and learned behavior;
2. the device camera and the image warp used as model input;
3. the transform used to display the encoded driver-camera frame.

## What changed in openpilot

The `DriverData` Cap'n Proto layout and output slicing are stable across the versions inspected. Both openpilot v0.10.3 and current master publish orientation from `face_descs[0:3]` and position from `face_descs[3:5]`. The on-device UI also retains the same coarse face-position approximation:

```text
tici_x = 1080 - 1714 * face_x
tici_y = -135 + 504 + abs(face_x) * 112
         + (1205 - abs(face_x) * 724) * face_y
```

For mici, openpilot scales the offset from the 2160×1080 canvas center by 1.25. The UI source calls this an approximation and still has a TODO to replace it with camera-point distortion.

The surrounding DM system did change:

- v0.10.3 introduced a new driver-monitoring model.
- Between the v0.10.3 and v0.11.1 tags, openpilot cycled through Ford GT,
  Ford GT Le Mans, Le Mans GT3, and Lancia Delta HF Integrale DM artifacts.
  Those models changed learned predictions while retaining the same logged
  `facePosition` field layout.
- The model input warp moved from `MonitoringModelFrame`/OpenCL to generated, camera-size-specific tinygrad warps. It also gained explicit camera-size discovery and constant-border handling.
- Modern `driverMonitoringState` uses policy-specific vision and wheel-touch state. The older flat state remains present in historical logs.
- Newer `DriverData` adds `sleepProb`; the existing position fields did not move.
- Tici/Tizi and Mici use different driver cameras. The common encoded sizes are 1928×1208 and 1344×760 respectively.

These are source-level compatibility facts, not a promise that every fork preserves a stock release's model or warp.

## Why the route version is not a compatibility key

The regression fixture
`f07115a587626e1a|00000525--989910eb06`, especially seconds 276 and 299,
reports openpilot `0.10.3`, but its route metadata points at
`nonokirby/openpilot@8e7ce87be8f306a21fe3fb103fee2871bbfe175c` on branch `Dom`.
That fork ported newer DM code into a v0.10.3-based tree. Therefore the display
version cannot identify the DM model generation, preprocessing implementation,
or expected prediction distribution.

The logs do not contain a standalone DM model name or artifact hash. Git commit
history can provide provenance when the recorded repository and commit remain
public, but it is not always resolvable: forks can disappear, become private, or
rewrite history.

Automatic compatibility decisions must use this order:

1. Logged facts: `initData.deviceType`, actual video dimensions, and schema shape.
2. Exact repository/commit and model-artifact history, when resolvable.
3. Route version only as a hint for a stock comma branch, never as proof for a fork.
4. An explicit user-selected DM compatibility profile when provenance is mixed
   or unavailable.

## Viewer behavior

The initial viewer used one 1928×1208 CSS canvas and read a `deviceType` property
from the route API response. Public route metadata does not reliably expose that
string, even though the qlog contains `initData.deviceType`. As a result, a mici
route could silently use the tici transform.

The viewer now:

- decodes and preserves the qlog's device type;
- falls back to the decoded video dimensions when device metadata is absent;
- selects an explicit tici or mici geometry profile;
- sizes the video shell to the actual decoded video aspect ratio;
- keeps the face-position projection in a tested module; and
- exposes a shareable renderer dropdown with a v0.10.3 position-only profile
  and a v0.11.1+ pose-aware compatibility profile.

The model-generation names are compatibility labels, not schema detection. The
v0.10.3 mode reproduces the upstream position-only anchor. The v0.11.1+ mode
retains the pose bias from the debug renderer that this web tool inherited. Auto
currently uses the newer pose-aware behavior while detecting the camera family
from the log/video. A `faceRenderer` query parameter preserves a manual choice
in shared links.

The current profile still reproduces openpilot's approximate projection. It is
not a true raw-frame face bounding box. The next geometry step is to replace the
approximation with camera-model projection and validate it against both fixture
times (276 as the control and 299 as the suspected mismatch), plus stock tici
and mici routes from multiple DM model generations.

## Regression fixtures

| Route/time | Purpose | Logged camera |
| --- | --- | --- |
| `f07115a587626e1a|00000525--989910eb06` at 276 s | Control: turned head; do not regress the current useful placement | mici, 1344×760 |
| Same route at 299 s | Suspected bad placement: forward-facing comparison | mici, 1344×760 |
| Public Mici demo at 446 s | Stable public fallback route | mici |

Tests should assert the selected profile and projected anchor numerically. A
visual browser regression should additionally capture the two route times when
live external route assets are available.

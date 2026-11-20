# Refract operator identity

Lumen uses a compact Facet symbol beside its lowercase wordmark. The mark is
citron in operator headers and on the desktop icon, with a white wordmark. Keep its height at or
below the wordmark; the four modules must remain separated at small sizes.

Operator surfaces remain neutral charcoal. Citron (`#DDFB73`) identifies focus,
selection, and primary actions; it is not a panel background. Red remains a live,
recording, or error signal. Public slides and Studio scene designs retain their
saved colours; changing the operator identity does not restyle audience content.

`FacetMark.vue` supplies the inline mark. `tokens.css` defines shared surfaces
and accent colours. The desktop icon and web favicon use the same geometry.

Selected tabs and toggle buttons use the shared `selection.css` treatment:
10% citron fill, a uniform 30% citron outline, and citron text/icons. There are
no bottom selection stripes. Colour samples and semantic recording/mute/live
states retain their own colours; keyboard focus remains separately visible.

Engine actions use the same restrained treatment throughout the header and Outputs:
Start engine is citron, while Stop engine is light red (`#EEA39A`), each with a
10% fill and a uniform 30% border. A connected broadcast shows a steady red dot
and **On Air** in both shared and switcher controls. Starting shows **Going live…**
in muted amber; ending, reconnecting, connection loss and unknown station status
remain distinct. On Air requires a live session and at least one connected
destination. The existing recording/broadcast engine-stop protection is retained.
The frontend production build and five broadcast-notice tests pass. Installed
Mac checks cover Studio, Notes editing, Outputs, computed action colours,
320/390px On Air headers, and the switcher. Broadcast state transitions were
verified with simulated telemetry in a disposable station; no public stream
was started for this UI update.

The shared Record control keeps Studio's neutral idle treatment in every channel.
While recording, it reads **Recording**, with a steady dot and the same light-red
text, 10% fill and 30% border as On Air. Clicking it still stops the current Program
recording; the tooltip and accessible action explain that behaviour. Finishing
remains a disabled state. Workspace-specific recording CSS overrides are removed
so Studio, Presentation, Scripture, Lyrics and Notes cannot restyle this control.
Installed-app verification compares idle and active computed styles in all five
workspaces, exercises the same stop request and disabled finishing state with
simulated recording telemetry, checks 320/390px headers, and verifies Notes
editing. No operator recording or station content is used by these checks.

`SegmentedMeter.vue` displays existing signal telemetry in 30 fixed segments.
Studio converts peaks to the existing -60 to 0 dBFS scale before display; Notes
and listening retain their existing normalized signal scale. Green, amber, and
red segments occupy fixed positions. These are input/output meters, not volume
settings: the adjacent Studio sliders still control gain independently.

## Validation of the initial rollout

The production build, desktop unit checks, Notes authoring/privacy/mobile checks,
Scripture/Lyrics responsive layouts, and audio status/segmented-meter checks pass.
The long real-audio browser suite reaches an engine-restart recovery failure;
comparison against the previously installed app also fails audio recovery after
restart. This rollout changes no audio routing or engine code and does not claim
to fix that pre-existing recovery issue.

The packaged Mac smoke check also passes: native startup, export/import, synthetic
camera setup, playable recording, and Notes authoring. The final continuity run
measured 30 fps at 1920×1080 with both visible and minimized operator windows.
These short synthetic checks do not establish hardware compatibility or resolve
the engine-restart audio limitation above.

## Selected controls and shared Lyrics validation

The November 20 selection/shared-Lyrics update passes the production build,
11 targeted backend tests, shared-Lyrics browser checks, and Notes authoring
checks. Installed-app checks cover the citron selected controls, Notes saving,
and the shared recognition provider in Lyrics.

The same signed package timed out receiving Program when run from the build
directory, but passed the full desktop check after installation in
`/Applications/Lumen.app`: output and recording delivered 1920×1080 at
29.8–29.9 fps with visible and minimized operator windows. The cause of the
build-directory failure is not established. The temporary debugger was removed
and the package signature verified before installation. Shared song-matching
tests use simulated transcripts; they do not establish live-band recognition
accuracy.

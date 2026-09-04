# android-sample — a phone application that exists to be built

The smallest Android app that can be compiled, installed on an emulator and
launched. It is a **fixture, not a product**: nothing imports it, and its only
job is to give `mobile-device-check.yml` something real to put on a device.

Why a real app rather than a mock: every other mobile test feeds the code a
string somebody wrote. That is how a cold-`adb` parsing bug survived 64 of
them. An emulator that boots, an APK that installs and an activity that draws
are the only evidence that the commands `mobile/stacks.py` computes are the
commands Gradle actually accepts.

No `gradle-wrapper.jar` is committed — a binary in the tree for a fixture is a
poor trade, and its absence exercises the other half of `_gradle_wrapper()`:
the fallback to a `gradle` on PATH, which is what CI provides.

Bump the pinned AGP / Kotlin / SDK versions when the toolchain moves. The job
is manual, so a stale pin here never blocks a pull request.

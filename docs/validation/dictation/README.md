# Dictation UI capture

These screenshots render the production `TaskDictation` component and production
styles in an isolated French preview, with a minimal surrounding description
field. The audio transport is simulated for the screenshots; this is not a
microphone or full Electron end-to-end test.

- `dictation-idle.png`: language selection before dictation.
- `dictation-draft.png`: editable transcript kept separate from the description.

Real offline transcription was checked separately using the actual Python runner
and multilingual model with French, English and Spanish synthetic WAV samples.

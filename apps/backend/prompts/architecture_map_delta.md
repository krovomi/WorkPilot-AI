## You are updating an existing model, not writing a new one

A model of this project already exists. It is reproduced in full below. Your job
is to produce the model **after** the change described by the task — by editing
that one, not by starting again.

**Keep every `id`.** The comparator matches components by `id` and by nothing
else. A component that still exists under a new id reads as one component
removed and a different one added, which is not a delta, it is noise. So:

- a component that still exists keeps its `id`, even when its label, type,
  sublabel, position or sources change;
- a component that genuinely no longer exists is removed;
- a genuinely new component gets a new id in the same naming style as its
  neighbours;
- `id`s of connections and boundaries follow the same rule.

Change only what the task actually changed. Redrawing the layout, renaming
things for consistency, or "improving" a component the task never touched all
show up as findings in the delta, and every one of them is a false one. If the
change is invisible at this altitude — an internal refactor inside one
component — then the correct answer is the base model returned unchanged.

### The change

{{TASK_SUMMARY}}

### Files this task changed

{{CHANGED_FILES}}

### The base model

```json
{{BASELINE_JSON}}
```

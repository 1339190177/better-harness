# Model Schema

The exact shape a bootstrapped model must take. This is arch-core's own model —
the shape the Impact host consumes and `architecture-model.ts` validates. Emit it
exactly, or the Impact pane reports the model as unreadable.

## `model.json`

A JSON object with two required arrays.

```json
{
  "elements": [
    {
      "id": "studio-server",
      "name": "Studio Server",
      "kind": "Component",
      "description": "Routes, providers and native host supervision.",
      "technology": "Node",
      "tags": ["server"],
      "parent_id": "harness-studio"
    }
  ],
  "relationships": [
    {
      "id": "server-calls-native",
      "source_id": "studio-server",
      "target_id": "native-services",
      "description": "calls staged hosts",
      "technology": null,
      "kind": "DeclaredRelationship"
    }
  ]
}
```

### Element fields

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Non-empty, unique across all elements. Stable ids keep diffs and bindings meaningful. |
| `name` | yes | Non-empty, human-readable. |
| `kind` | yes | One of `Person`, `SoftwareSystem`, `Container`, `Component`. |
| `description` | no | One line grounded in what the element's files do. `null` allowed. |
| `technology` | no | Free text or `null`. |
| `tags` | no | String array. Keep a `generated` tag on any element still unconfirmed. |
| `parent_id` | no | The `id` of the containing element, or `null` for a root. Must reference a real element. |

### Relationship fields

| Field | Required | Rule |
|---|---|---|
| `id` | yes | Non-empty, unique across relationships. |
| `source_id` / `target_id` | yes | Each must be an existing element `id`. Never point at an element you did not keep. |
| `kind` | yes | One of `Contains`, `Imports`, `ResolvedCall`, `DeclaredHttp`, `DeclaredRelationship`. |
| `description` | no | What crosses the relationship. |
| `technology` | no | Free text or `null`. |

Use the kind that fits the evidence: `Imports`/`ResolvedCall` for observed code
edges, `DeclaredHttp` for a declared HTTP dependency, `DeclaredRelationship` for a
hand-declared one, and `Contains` only where a parent/child is not already
expressed by `parent_id`.

## `bindings.json`

A JSON array mapping path globs to element ids. Every element that should light
up when its code changes needs at least one binding; an element with no binding
draws but never marks.

```json
[
  { "path_glob": "packages/harness-studio/src/server/**", "element_id": "studio-server" }
]
```

- `path_glob` must match at least one real tracked path in the worktree.
- `element_id` must be an `id` present in `model.json`.
- Prefer the narrowest glob that captures the element's sources; overlapping
  globs bind a path to the first element that matches it.

## Validity checklist

Before handing the model back for **Save as declared model**:

- [ ] `elements` and `relationships` are both arrays.
- [ ] Every element has a non-empty `id` and `name`, and a valid `kind`.
- [ ] Every `parent_id`, `source_id`, and `target_id` references an existing element.
- [ ] Every binding `element_id` exists, and every `path_glob` matches a real path.
- [ ] No element is kept without at least one binding grounding it in real source.
- [ ] Proposed external systems / people carry their evidence in the description.

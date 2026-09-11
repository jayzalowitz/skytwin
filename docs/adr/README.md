# Architecture decision records

Architecture decisions are numbered in creation order. An `Accepted` record is
a reviewed implementation contract, not evidence that its design has shipped.
Each record names the implementation and public-claim gates that still apply.

| ADR                                                      | Status   | Decision                                                |
| -------------------------------------------------------- | -------- | ------------------------------------------------------- |
| [0001](./0001-local-source-field-encryption-boundary.md) | Accepted | Local source-field encryption and locked-state contract |

## Merge topology for ADR 0001

The ownership/encryption-gate delivery is a composition/superset change, not an
independently mergeable third implementation line. Its final history must be
stacked on the runtime composition in #650 and retain #637 as the merge parent
for the overlapping ADR/inventory work. The current working branch stages that
combined result on #650; before opening or updating the final PR, preserve the
#637 parent explicitly. Do not merge #637 or another overlapping ownership
branch independently after the superset lands.

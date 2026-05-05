# content-flattening

Pi `content` is canonically an array of content blocks. The mapper flattens text blocks via concatenation and drops everything else (image, etc.):

| input content | flattened |
|---|---|
| `[{type:"text",text:"part1 "},{type:"text",text:"part2"}]` | `"part1 part2"` |
| `[{type:"text",text:"caption"},{type:"image",...}]` | `"caption"` |
| `[]` | `""` |
| plain string `"plain string still works"` | unchanged (legacy compat) |

Image blocks are dropped at this layer because the workspace events surface text. If/when the UI needs images, Stage 2+ will add a richer event family.

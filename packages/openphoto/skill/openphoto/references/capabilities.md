# Supported Commands

`document.mutate.payload.commands` accepts one to twenty commands. Each command has only `id` and `args`; all arguments are required unless noted otherwise.

- `canvas.resize`: `{ "width": positiveSafeInteger, "height": positiveSafeInteger }`; each dimension is at most `30000` and their product is at most `80000000`.
- `canvas.crop`: `{ "x": -30000..30000, "y": -30000..30000, "width": positiveNumber <= 30000, "height": positiveNumber <= 30000 }`; rounded output dimensions may not exceed `80000000` pixels.
- `canvas.rotate`: `{ "degrees": 90 | -90 | 180 | -180 }`; positive `degrees` means clockwise; negative `degrees` means counterclockwise.
- `canvas.flip`: `{ "axis": "h" | "v" }`
- `canvas.flatten`: `{}`
- `object.transform.set`: `{ "objectId": string, "left": -300000..300000, "top": -300000..300000, "scaleX": positiveNumber <= 1000, "scaleY": positiveNumber <= 1000, "angle": -36000..36000, "flipX": boolean, "flipY": boolean }`
- `object.rotate`: `{ "objectId": string, "degrees": -3600..3600 }`
- `object.flip`: `{ "objectId": string, "axis": "h" | "v" }`
- `image.adjust`: `{ "objectId": string, "brightness": -100..100, "contrast": -100..100, "saturation": -100..100, "hue": -180..180, "blur": 0..100 }`
- `filter.apply`: `{ "objectId": string, "name": "Grayscale" | "Invert" | "Sepia" | "BlackWhite" | "Sharpen" | "Emboss" }`

# Protocol Workflows

Run all commands from the Skill root. Every example below is one complete JSON request. Save one request at a time as `request.json`, then run:

```powershell
node bin/openphoto.mjs request --file request.json
```

For an inline request, use `node bin/openphoto.mjs request --json '<single JSON request object>'`. Do not send an array of requests.

## Edit and Export

Import a local PNG or JPEG:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "import-1",
  "op": "artifact.import",
  "payload": { "sourcePath": "C:/images/photo.png" }
}
```

Open the imported artifact:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "open-1",
  "op": "document.open",
  "payload": { "artifactId": "<artifactId from import result>" }
}
```

Inspect the document to obtain its object IDs and current revision:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "inspect-1",
  "op": "document.inspect",
  "documentId": "<documentId from open result>",
  "payload": {}
}
```

Apply a mutation. This example starts from revision `0`; its `"degrees": 90` command rotates the canvas clockwise. Substitute the revision returned by the preceding inspect response.

```json
{
  "protocol": "openphoto/v1",
  "requestId": "mutate-1",
  "op": "document.mutate",
  "documentId": "<documentId>",
  "expectedRevision": 0,
  "payload": {
    "commands": [
      { "id": "canvas.rotate", "args": { "degrees": 90 } }
    ]
  }
}
```

Inspect again after a mutation. The rotation above advances the revision to `1`; use the actual inspected revision when rendering:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "render-1",
  "op": "document.renderArtifact",
  "documentId": "<documentId>",
  "expectedRevision": 1,
  "payload": { "format": "png" }
}
```

Read the rendered artifact to obtain its metadata and local read-only path:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "read-1",
  "op": "artifact.read",
  "payload": { "artifactId": "<artifactId from render result>" }
}
```

The protocol has no RPC that accepts an output path. `artifact.read` returns metadata with a read-only source `path`. If the user specifies a target path, the host shell must copy from that `path`; it must not overwrite an existing file without confirmation.

Close the document when finished:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "close-1",
  "op": "document.close",
  "documentId": "<documentId>",
  "payload": {}
}
```

## AI Analysis and Apply

Use the object ID and revision from `document.inspect`. This example continues after the rotation above, so it uses revision `1`; substitute the current value for a different document state.

```json
{
  "protocol": "openphoto/v1",
  "requestId": "analysis-1",
  "op": "ai.analyze.start",
  "documentId": "<documentId>",
  "payload": {
    "capability": "background-remove",
    "objectId": "<objectId from inspect result>",
    "sourceRevision": 1
  }
}
```

The model-backed capability mapping is:

| Capability | Model ID |
| --- | --- |
| `background-remove` | `Xenova/modnet` |
| `depth` | `Xenova/depth-anything-small-hf` |
| `detect` | `Xenova/detr-resnet-50` |
| `segment` | `Xenova/detr-resnet-50-panoptic` |
| `upscale` | No model download |

`segment` also needs a normalized `point`, for example `{ "x": 0.5, "y": 0.5 }`. `upscale` needs `factor: 2` or `4`.

If `ai.analyze.start` returns `MODEL_DOWNLOAD_REQUIRED`, use its `details` to explain the model ID, revision, source, license, total bytes, and cache root to the user. Its `details.jobId` identifies the waiting analysis job. Obtain explicit user approval before installing the model:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "install-1",
  "op": "model.install",
  "payload": { "modelId": "Xenova/modnet" }
}
```

Poll the returned installation ID until it is complete:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "install-status-1",
  "op": "model.status",
  "payload": { "installId": "<installId from install result>" }
}
```

Then poll the waiting analysis job. `ai.job.get` does not take a `documentId`:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "job-1",
  "op": "ai.job.get",
  "payload": { "jobId": "<jobId from analysis result or error details>" }
}
```

Jobs progress through `queued`, `running`, `waiting_for_model`, `completed`, or `failed`. A completed `detect` job returns `kind: "json"` with boxes; report it and do not apply it. Other completed jobs return `kind: "raster"` with `artifact`, `targetObjectId`, and `placement`.

Analysis never changes the document. Before applying a raster, inspect the document again and use its current revision, then preserve the `targetObjectId` and `placement` returned by the job rather than hard-coding either value:

```json
{
  "protocol": "openphoto/v1",
  "requestId": "apply-1",
  "op": "document.applyArtifact",
  "documentId": "<documentId>",
  "expectedRevision": 1,
  "payload": {
    "artifactId": "<completed result.artifact.artifactId>",
    "targetObjectId": "<completed result.targetObjectId>",
    "placement": "<completed result.placement>"
  }
}
```

`document.applyArtifact` is the only operation that writes an AI raster to the document. Render and read it through the ordinary workflow if an output file is needed, then close the document.

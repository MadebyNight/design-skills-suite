(() => {
  'use strict'

  const COMMANDS = new Set([
    'canvas.resize', 'canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten',
    'object.transform.set', 'object.rotate', 'object.flip',
    'image.adjust', 'filter.apply'
  ])
  const RASTERIZING_CANVAS_COMMANDS = new Set([
    'canvas.crop', 'canvas.rotate', 'canvas.flip', 'canvas.flatten'
  ])
  const MODEL_TASKS = new Map([
    ['background-remove', { id: 'Xenova/modnet', task: 'background-removal' }],
    ['depth', { id: 'Xenova/depth-anything-small-hf', task: 'depth-estimation' }],
    ['detect', { id: 'Xenova/detr-resnet-50', task: 'object-detection' }],
    ['segment', { id: 'Xenova/detr-resnet-50-panoptic', task: 'image-segmentation' }]
  ])
  const RASTER_CAPABILITIES = new Set(['background-remove', 'depth', 'segment', 'upscale'])
  const localPipelines = new Map()

  const failure = (code, message) => {
    const error = new Error(`${code}: ${message}`)
    error.code = code
    return error
  }

  const isPlainObject = value => value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

  const assertReady = () => {
    if (typeof OS === 'undefined' || !OS.canvas || typeof OS._normalizeCommand !== 'function') {
      throw failure('RUNTIME_CRASH', 'OpenShop is not ready')
    }
  }

  const numericBounds = bounds => ({
    x: Number(bounds.left ?? bounds.x ?? 0),
    y: Number(bounds.top ?? bounds.y ?? 0),
    width: Number(bounds.width ?? 0),
    height: Number(bounds.height ?? 0)
  })

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

  function assertRasterDataUrl(value, message = 'dataUrl must be a PNG or JPEG data URL') {
    if (typeof value !== 'string' || !/^data:image\/(?:png|jpeg);base64,/iu.test(value)) {
      throw failure('INVALID_REQUEST', message)
    }
    return value
  }

  function canvasForSize(width, height) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw failure('RUNTIME_CRASH', '2D canvas is unavailable')
    return { canvas, context }
  }

  async function canvasFromDataUrl(dataUrl, expectedWidth = null, expectedHeight = null) {
    assertRasterDataUrl(dataUrl)
    const image = new Image()
    image.src = dataUrl
    await image.decode()
    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw failure('INVALID_REQUEST', 'input image has invalid dimensions')
    }
    if ((expectedWidth !== null && width !== expectedWidth) || (expectedHeight !== null && height !== expectedHeight)) {
      throw failure('INVALID_REQUEST', 'input image dimensions do not match its metadata')
    }
    const { canvas, context } = canvasForSize(width, height)
    context.drawImage(image, 0, 0)
    return canvas
  }

  function cloneSourceCanvas(target) {
    const element = target?.getElement?.()
    const width = element?.naturalWidth || element?.width || target?.width
    const height = element?.naturalHeight || element?.height || target?.height
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw failure('RUNTIME_CRASH', 'target image has invalid dimensions')
    }
    const { canvas, context } = canvasForSize(width, height)
    context.drawImage(element, 0, 0, width, height)
    return canvas
  }

  function imageTarget(objectId) {
    if (typeof objectId !== 'string' || !objectId) throw failure('INVALID_REQUEST', 'objectId is required')
    const target = OS.canvas.getObjects().find(object => object?.name !== '__boundary__'
      && object?.type === 'image' && object._openShopObjectId === objectId)
    if (!target) throw failure('NOT_FOUND', 'target image not found')
    return target
  }

  function descriptor() {
    assertReady()
    const objects = OS.canvas.getObjects()
      .filter(object => object?.name !== '__boundary__')
      .map(object => {
        const id = OS._ensureObjectId(object)
        const bounds = object.getBoundingRect?.() ?? {
          left: object.left,
          top: object.top,
          width: object.getScaledWidth?.() ?? object.width,
          height: object.getScaledHeight?.() ?? object.height
        }
        return {
          objectId: id,
          type: String(object.type ?? 'unknown'),
          bounds: numericBounds(bounds),
          ...(object.type === 'image'
            ? { imageState: { filterCount: Array.isArray(object.filters) ? object.filters.length : 0 } }
            : {})
        }
      })
    return {
      canvas: { width: OS.canvasW, height: OS.canvasH },
      objects,
      revision: OS._documentRevision
    }
  }

  function normalizeOpenPhotoCommands(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) {
      throw failure('INVALID_REQUEST', 'commands must contain 1 to 20 entries')
    }
    return raw.map((command, index) => {
      if (!isPlainObject(command) || !COMMANDS.has(command.id)) {
        throw failure('UNSUPPORTED_CAPABILITY', `unsupported command at index ${index}`)
      }
      const keys = Object.keys(command)
      if (!keys.every(key => ['id', 'args'].includes(key)) || !isPlainObject(command.args)) {
        throw failure('INVALID_REQUEST', `invalid command at index ${index}`)
      }
      try {
        return OS._normalizeCommand({
          schemaVersion: OS._commandSchemaVersion,
          id: command.id,
          args: command.args
        }, { allowSequence: false })
      } catch (error) {
        throw failure('INVALID_REQUEST', error?.message || `invalid command at index ${index}`)
      }
    })
  }

  function ensureCommandTarget(command) {
    if (!Object.hasOwn(command.args, 'objectId')) return
    const target = OS.canvas.getObjects().find(object => object?.name !== '__boundary__'
      && OS._ensureObjectId(object) === command.args.objectId)
    if (!target) throw failure('NOT_FOUND', 'target object not found')
    if (['image.adjust', 'filter.apply'].includes(command.id) && target.type !== 'image') {
      throw failure('INVALID_REQUEST', 'target object must be an image')
    }
  }

  function primaryImage() {
    const image = OS.canvas.getObjects().find(object => object?.name !== '__boundary__' && object?.type === 'image')
    if (!image) throw failure('RUNTIME_CRASH', 'primary image is missing')
    return image
  }

  async function executeOpenPhotoBatch(raw) {
    const commands = normalizeOpenPhotoCommands(raw)
    let transaction = false
    try {
      OS._beginHistoryTransaction(commands[0], { label: 'OpenPhoto edit', recordMacro: false })
      transaction = true
      for (const command of commands) {
        ensureCommandTarget(command)
        const retainedPrimaryImageId = RASTERIZING_CANVAS_COMMANDS.has(command.id)
          ? OS._ensureObjectId(primaryImage())
          : null
        if (await OS._invokeCommand(command) === false) {
          throw failure('INVALID_REQUEST', `command failed: ${command.id}`)
        }
        if (retainedPrimaryImageId) {
          primaryImage()._openShopObjectId = retainedPrimaryImageId
        } else if (command.id === 'filter.apply') {
          const active = OS.canvas.getActiveObject()
          if (active?.type === 'image') active._openShopObjectId = command.args.objectId
        }
      }
      const changed = OS._commitHistoryTransaction()
      transaction = false
      return { appliedCommands: commands.length, changed }
    } catch (error) {
      if (transaction) await OS._rollbackHistoryTransaction(error)
      throw error
    }
  }

  async function open(spec) {
    assertReady()
    if (!isPlainObject(spec) || !(spec.blob instanceof Blob) || typeof spec.name !== 'string' || !spec.name) {
      throw failure('INVALID_REQUEST', 'open requires an image Blob and name')
    }
    await OS._applyToolDocument(spec)
    return descriptor()
  }

  async function mutate({ expectedRevision, commands } = {}) {
    assertReady()
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw failure('INVALID_REQUEST', 'expectedRevision is required')
    }
    if (expectedRevision !== OS._documentRevision) {
      throw failure('REVISION_CONFLICT', 'document revision changed')
    }
    const result = await executeOpenPhotoBatch(commands)
    return { ...result, revision: OS._documentRevision, descriptor: descriptor() }
  }

  async function renderJpeg({ quality, matte }) {
    const captured = OS._captureExportRaster({ format: 'png', transparent: true })
    const image = new Image()
    image.src = captured.dataUrl
    await image.decode()

    const { canvas, context } = canvasForSize(OS.canvasW, OS.canvasH)
    context.fillStyle = matte
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0)

    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    if (!dataUrl.startsWith('data:image/jpeg;base64,')) {
      throw failure('RUNTIME_CRASH', 'JPEG encoding is not supported by this browser')
    }
    return dataUrl
  }

  async function render({ expectedRevision, format = 'png', quality = 0.92, matte = '#ffffff' } = {}) {
    assertReady()
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw failure('INVALID_REQUEST', 'expectedRevision is required')
    }
    if (expectedRevision !== OS._documentRevision) {
      throw failure('REVISION_CONFLICT', 'document revision changed')
    }
    const normalizedFormat = format === 'jpg' ? 'jpeg' : format
    if (!['png', 'jpeg'].includes(normalizedFormat)) {
      throw failure('FORMAT_UNSUPPORTED', 'unsupported output format')
    }
    if (typeof quality !== 'number' || !Number.isFinite(quality) || quality <= 0 || quality > 1) {
      throw failure('INVALID_REQUEST', 'quality must be a number between 0 and 1')
    }
    if (typeof matte !== 'string') throw failure('INVALID_REQUEST', 'matte must be a CSS color string')
    const dataUrl = normalizedFormat === 'jpeg'
      ? await renderJpeg({ quality, matte })
      : OS._captureExportRaster({ format: 'png', quality, matte, transparent: true }).dataUrl
    return {
      dataUrl,
      width: OS.canvasW,
      height: OS.canvasH,
      format: normalizedFormat
    }
  }

  function captureInput({ objectId } = {}) {
    assertReady()
    const target = imageTarget(objectId)
    const source = cloneSourceCanvas(target)
    return {
      dataUrl: source.toDataURL('image/png'),
      width: source.width,
      height: source.height,
      targetObjectId: objectId
    }
  }

  async function readAnalysisInput(input) {
    if (!isPlainObject(input)
      || typeof input.targetObjectId !== 'string' || !input.targetObjectId
      || !Number.isSafeInteger(input.width) || input.width < 1
      || !Number.isSafeInteger(input.height) || input.height < 1) {
      throw failure('INVALID_REQUEST', 'analysis input is invalid')
    }
    return {
      ...input,
      canvas: await canvasFromDataUrl(input.dataUrl, input.width, input.height)
    }
  }

  function requiredModel(capability, candidate) {
    const expected = MODEL_TASKS.get(capability)
    if (!expected) return null
    if (!isPlainObject(candidate)
      || candidate.id !== expected.id
      || typeof candidate.revision !== 'string' || !candidate.revision
      || typeof candidate.localModelPath !== 'string' || !candidate.localModelPath) {
      throw failure('INVALID_REQUEST', `local ${capability} model descriptor is invalid`)
    }
    return { ...candidate, task: expected.task }
  }

  async function loadLocalTransformers(model) {
    const lib = await OS._loadTransformers()
    if (!lib?.env) throw failure('RUNTIME_CRASH', 'Transformers runtime is unavailable')
    lib.env.allowLocalModels = true
    lib.env.allowRemoteModels = false
    lib.env.localModelPath = model.localModelPath
    return lib
  }

  async function localPipeline(model) {
    const lib = await loadLocalTransformers(model)
    const key = `${model.task}:${model.id}:${model.revision}:${model.localModelPath}`
    let pending = localPipelines.get(key)
    if (!pending) {
      pending = lib.pipeline(model.task, model.id, {
        revision: model.revision,
        local_files_only: true
      })
      localPipelines.set(key, pending)
    }
    try {
      return { lib, pipeline: await pending }
    } catch (error) {
      localPipelines.delete(key)
      throw error
    }
  }

  function rawImageFromCanvas(lib, canvas) {
    const context = canvas.getContext('2d')
    if (!context || !lib?.RawImage) throw failure('RUNTIME_CRASH', 'Transformers image runtime is unavailable')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    return new lib.RawImage(new Uint8ClampedArray(data), canvas.width, canvas.height, 4)
  }

  function rasterInfo(value) {
    const data = value?.data
    const width = Number(value?.width)
    const height = Number(value?.height)
    if (!ArrayBuffer.isView(data) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      return null
    }
    const channels = Number(value?.channels) || Math.round(data.length / (width * height))
    if (!Number.isSafeInteger(channels) || channels < 1 || data.length < width * height * channels) return null
    return { data, width, height, channels }
  }

  function rasterChannel(info, x, y, channel = 0) {
    const px = clamp(Math.round(x), 0, info.width - 1)
    const py = clamp(Math.round(y), 0, info.height - 1)
    return Number(info.data[(py * info.width + px) * info.channels + Math.min(channel, info.channels - 1)]) || 0
  }

  function outputDataUrl(canvas) {
    const dataUrl = canvas.toDataURL('image/png')
    return assertRasterDataUrl(dataUrl, 'browser could not encode a PNG result')
  }

  function rasterResult(dataUrl, input, placement) {
    return {
      kind: 'raster',
      dataUrl: assertRasterDataUrl(dataUrl),
      targetObjectId: input.targetObjectId,
      placement
    }
  }

  function normalizeBox(box, input) {
    if (!isPlainObject(box)) throw failure('RUNTIME_CRASH', 'detector returned an invalid box')
    const rawX = Number(box.x ?? box.xmin)
    const rawY = Number(box.y ?? box.ymin)
    const rawWidth = Number(box.width ?? (Number(box.xmax) - rawX))
    const rawHeight = Number(box.height ?? (Number(box.ymax) - rawY))
    if (![rawX, rawY, rawWidth, rawHeight].every(Number.isFinite)) {
      throw failure('RUNTIME_CRASH', 'detector returned non-numeric box coordinates')
    }
    const usePixels = [rawX, rawY, rawWidth, rawHeight].some(value => Math.abs(value) > 1)
    const x = clamp(usePixels ? rawX / input.width : rawX, 0, 1)
    const y = clamp(usePixels ? rawY / input.height : rawY, 0, 1)
    const right = clamp(usePixels ? (rawX + rawWidth) / input.width : rawX + rawWidth, x, 1)
    const bottom = clamp(usePixels ? (rawY + rawHeight) / input.height : rawY + rawHeight, y, 1)
    return { x, y, width: right - x, height: bottom - y }
  }

  function detectionResult(results, input) {
    const entries = Array.isArray(results) ? results : results?.boxes
    if (!Array.isArray(entries)) throw failure('RUNTIME_CRASH', 'detector returned an invalid result')
    return {
      kind: 'json',
      value: {
        boxes: entries.map(entry => ({
          label: String(entry?.label ?? ''),
          score: Number(entry?.score ?? 0),
          box: normalizeBox(entry?.box ?? entry, input)
        }))
      }
    }
  }

  function maskInfo(value) {
    const source = value?.mask ?? value?.segmentation ?? value?.image ?? value
    const info = rasterInfo(source)
    if (!info) return null
    let max = 0
    for (let index = 0; index < info.data.length; index += info.channels) {
      const valueAtPixel = info.channels >= 4
        ? Math.max(info.data[index] || 0, info.data[index + 1] || 0, info.data[index + 2] || 0, info.data[index + 3] || 0)
        : info.data[index] || 0
      max = Math.max(max, Number(valueAtPixel) || 0)
    }
    return { ...info, threshold: max <= 1 ? 0.5 : max / 2 }
  }

  function maskActive(info, x, y) {
    const index = (clamp(Math.round(y), 0, info.height - 1) * info.width + clamp(Math.round(x), 0, info.width - 1)) * info.channels
    const value = info.channels >= 4
      ? Math.max(info.data[index] || 0, info.data[index + 1] || 0, info.data[index + 2] || 0, info.data[index + 3] || 0)
      : info.data[index] || 0
    return value > info.threshold
  }

  function selectSegment(results, point) {
    const entries = Array.isArray(results) ? results : results?.segments ?? results?.masks
    if (!Array.isArray(entries)) throw failure('RUNTIME_CRASH', 'segmenter returned an invalid result')
    const candidates = entries
      .map(segment => ({ segment, info: maskInfo(segment) }))
      .filter(({ info }) => info && maskActive(info, point.x * (info.width - 1), point.y * (info.height - 1)))
      .sort((left, right) => Number(right.segment?.score ?? 0) - Number(left.segment?.score ?? 0))
    if (!candidates.length) throw failure('NOT_FOUND', 'no segment contains the requested point')
    return candidates[0].info
  }

  function assertNormalizedPoint(point) {
    if (!isPlainObject(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) {
      throw failure('INVALID_REQUEST', 'point must contain normalized x and y coordinates')
    }
    return point
  }

  async function analyzeBackground(input, model) {
    const { lib, pipeline } = await localPipeline(model)
    const result = await pipeline(rawImageFromCanvas(lib, input.canvas))
    const alpha = rasterInfo(Array.isArray(result) ? result[0] : result)
    if (!alpha) throw failure('RUNTIME_CRASH', 'background model returned an invalid raster')
    const { canvas, context } = canvasForSize(input.width, input.height)
    context.drawImage(input.canvas, 0, 0)
    const pixels = context.getImageData(0, 0, input.width, input.height)
    for (let y = 0; y < input.height; y++) {
      for (let x = 0; x < input.width; x++) {
        const value = rasterChannel(alpha, x * (alpha.width - 1) / Math.max(1, input.width - 1), y * (alpha.height - 1) / Math.max(1, input.height - 1), alpha.channels >= 4 ? 3 : 0)
        pixels.data[(y * input.width + x) * 4 + 3] = clamp(value <= 1 ? value * 255 : value, 0, 255)
      }
    }
    context.putImageData(pixels, 0, 0)
    return rasterResult(outputDataUrl(canvas), input, 'replace-target')
  }

  async function analyzeDepth(input, model) {
    const { lib, pipeline } = await localPipeline(model)
    const result = await pipeline(rawImageFromCanvas(lib, input.canvas))
    const depth = rasterInfo(result?.depth ?? result)
    if (!depth) throw failure('RUNTIME_CRASH', 'depth model returned an invalid raster')
    let minimum = Infinity
    let maximum = -Infinity
    for (let y = 0; y < depth.height; y++) {
      for (let x = 0; x < depth.width; x++) {
        const value = rasterChannel(depth, x, y)
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
    }
    const { canvas: depthCanvas, context: depthContext } = canvasForSize(depth.width, depth.height)
    const pixels = depthContext.createImageData(depth.width, depth.height)
    const range = maximum - minimum || 1
    for (let y = 0; y < depth.height; y++) {
      for (let x = 0; x < depth.width; x++) {
        const value = Math.round((rasterChannel(depth, x, y) - minimum) / range * 255)
        const index = (y * depth.width + x) * 4
        pixels.data[index] = value
        pixels.data[index + 1] = value
        pixels.data[index + 2] = value
        pixels.data[index + 3] = 255
      }
    }
    depthContext.putImageData(pixels, 0, 0)
    const { canvas, context } = canvasForSize(input.width, input.height)
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(depthCanvas, 0, 0, input.width, input.height)
    return rasterResult(outputDataUrl(canvas), input, 'add-above-target')
  }

  async function analyzeDetect(input, model) {
    const { lib, pipeline } = await localPipeline(model)
    return detectionResult(await pipeline(rawImageFromCanvas(lib, input.canvas), { threshold: 0.7, percentage: true }), input)
  }

  async function analyzeSegment(input, point, model) {
    const { lib, pipeline } = await localPipeline(model)
    const mask = selectSegment(await pipeline(rawImageFromCanvas(lib, input.canvas)), assertNormalizedPoint(point))
    const { canvas, context } = canvasForSize(input.width, input.height)
    const pixels = context.createImageData(input.width, input.height)
    for (let y = 0; y < input.height; y++) {
      for (let x = 0; x < input.width; x++) {
        const active = maskActive(mask, x * (mask.width - 1) / Math.max(1, input.width - 1), y * (mask.height - 1) / Math.max(1, input.height - 1))
        const index = (y * input.width + x) * 4
        const value = active ? 255 : 0
        pixels.data[index] = value
        pixels.data[index + 1] = value
        pixels.data[index + 2] = value
        pixels.data[index + 3] = 255
      }
    }
    context.putImageData(pixels, 0, 0)
    return rasterResult(outputDataUrl(canvas), input, 'add-above-target')
  }

  function sharpen(canvas) {
    const { canvas: blurCanvas, context: blurContext } = canvasForSize(canvas.width, canvas.height)
    blurContext.filter = 'blur(1px)'
    blurContext.drawImage(canvas, 0, 0)
    const context = canvas.getContext('2d')
    if (!context) throw failure('RUNTIME_CRASH', 'upscale canvas is unavailable')
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
    const blurred = blurContext.getImageData(0, 0, canvas.width, canvas.height).data
    for (let index = 0; index < pixels.data.length; index += 4) {
      for (let channel = 0; channel < 3; channel++) {
        pixels.data[index + channel] = clamp(pixels.data[index + channel] + (pixels.data[index + channel] - blurred[index + channel]) * 0.5, 0, 255)
      }
    }
    context.putImageData(pixels, 0, 0)
  }

  function analyzeUpscale(input, factor) {
    if (factor !== 2 && factor !== 4) throw failure('INVALID_REQUEST', 'upscale factor must be 2 or 4')
    let current = input.canvas
    for (let scale = 2; scale <= factor; scale *= 2) {
      const { canvas, context } = canvasForSize(current.width * 2, current.height * 2)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(current, 0, 0, canvas.width, canvas.height)
      current = canvas
    }
    sharpen(current)
    return rasterResult(outputDataUrl(current), input, 'replace-target')
  }

  function normalizeTestResult(result, capability, input) {
    if (!isPlainObject(result)) throw failure('RUNTIME_CRASH', 'test pipeline returned an invalid result')
    if (capability === 'detect') {
      if (result.kind !== 'json') throw failure('RUNTIME_CRASH', 'test detector must return JSON')
      return detectionResult(result.value, input)
    }
    if (result.kind !== 'raster') throw failure('RUNTIME_CRASH', 'test pipeline must return a raster')
    return rasterResult(result.dataUrl, input, result.placement || (capability === 'depth' || capability === 'segment' ? 'add-above-target' : 'replace-target'))
  }

  async function analyze({ capability, input, point, factor, model } = {}) {
    assertReady()
    if (!RASTER_CAPABILITIES.has(capability) && capability !== 'detect') {
      throw failure('UNSUPPORTED_CAPABILITY', 'unsupported AI capability')
    }
    const analysisInput = await readAnalysisInput(input)
    const localModel = requiredModel(capability, model)
    if (typeof window.__OPENPHOTO_TEST_PIPELINE__ === 'function') {
      return normalizeTestResult(
        await window.__OPENPHOTO_TEST_PIPELINE__({ capability, input, point, factor, model }),
        capability,
        analysisInput
      )
    }
    if (capability === 'background-remove') return analyzeBackground(analysisInput, localModel)
    if (capability === 'depth') return analyzeDepth(analysisInput, localModel)
    if (capability === 'detect') return analyzeDetect(analysisInput, localModel)
    if (capability === 'segment') return analyzeSegment(analysisInput, point, localModel)
    return analyzeUpscale(analysisInput, factor)
  }

  function copyTargetTransform(image, target) {
    image.set({
      left: target.left,
      top: target.top,
      scaleX: target.scaleX,
      scaleY: target.scaleY,
      angle: target.angle,
      flipX: target.flipX,
      flipY: target.flipY,
      skewX: target.skewX,
      skewY: target.skewY,
      originX: target.originX,
      originY: target.originY,
      opacity: target.opacity,
      globalCompositeOperation: target.globalCompositeOperation,
      visible: target.visible,
      selectable: true,
      evented: true,
      name: target.name || 'AI artifact'
    })
  }

  function insertCanvasObject(object, index) {
    if (typeof OS.canvas.insertAt === 'function') {
      OS.canvas.insertAt(index, object)
      return
    }
    OS.canvas.add(object)
    OS.canvas.moveObjectTo?.(object, index)
  }

  async function apply({ dataUrl, targetObjectId, placement, expectedRevision } = {}) {
    assertReady()
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw failure('INVALID_REQUEST', 'expectedRevision is required')
    }
    if (expectedRevision !== OS._documentRevision) {
      throw failure('REVISION_CONFLICT', 'document revision changed')
    }
    if (!['replace-target', 'add-above-target'].includes(placement)) {
      throw failure('INVALID_REQUEST', 'placement is invalid')
    }
    assertRasterDataUrl(dataUrl)
    const target = imageTarget(targetObjectId)
    const image = await fabric.Image.fromURL(dataUrl)
    if (expectedRevision !== OS._documentRevision) {
      throw failure('REVISION_CONFLICT', 'document revision changed')
    }
    const layerIndex = OS._getObjectLayerIndex(target)
    const layer = OS.layers?.[layerIndex]
    const objectIndex = layer?.objects?.indexOf(target) ?? -1
    const canvasIndex = OS.canvas.getObjects().indexOf(target)
    if (objectIndex < 0 || canvasIndex < 0) throw failure('RUNTIME_CRASH', 'target layer is unavailable')
    copyTargetTransform(image, target)
    if (placement === 'replace-target') {
      image._openShopObjectId = targetObjectId
      layer.objects[objectIndex] = image
      OS.canvas.remove(target)
      insertCanvasObject(image, canvasIndex)
    } else {
      const usedIds = new Set(OS.canvas.getObjects().map(object => object?._openShopObjectId).filter(Boolean))
      OS._ensureObjectId(image, usedIds)
      layer.objects.splice(objectIndex + 1, 0, image)
      insertCanvasObject(image, canvasIndex + 1)
    }
    OS._enforceLayerInvariants?.({ render: false })
    OS.canvas.setActiveObject(image)
    OS.canvas.renderAll()
    OS.saveHistory('Apply AI artifact')
    OS.updateLayersPanel()
    return { revision: OS._documentRevision, descriptor: descriptor() }
  }

  window.__openphoto = Object.freeze({
    version: 'openphoto-bridge/v1',
    open,
    inspect: descriptor,
    mutate,
    render,
    captureInput,
    analyze,
    apply
  })
  document.documentElement.dataset.openphotoReady = 'true'
})()

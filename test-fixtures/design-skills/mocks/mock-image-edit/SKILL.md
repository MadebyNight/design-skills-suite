# mock-image-edit

仅用于 capability conformance 的确定性图片编辑替身。它提供 `image.crop`、
`image.resize`、`image.export`，通过注入式调用返回合法 `AssetResult`，不实现
OpenPhoto 私有协议，也不用于生产。

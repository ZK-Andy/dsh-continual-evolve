// G3 红样本：被委托方直接吃 Config。R1 的边已登记、R2/R4 不涉，所以判红只可能来自 R3。
import type { EvolveConfig } from "./index.js";

export function mount(config: EvolveConfig): boolean {
	return config.memoryIndex?.extraction !== false;
}

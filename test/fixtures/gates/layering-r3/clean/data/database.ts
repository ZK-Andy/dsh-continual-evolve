// G3 绿样本：局部变量叫 config 不算读 Config，R3 只看 EvolveConfig 这个名字。
export interface LocalSettings {
	read: () => boolean;
}

export function armed(config: LocalSettings): boolean {
	return config.read();
}

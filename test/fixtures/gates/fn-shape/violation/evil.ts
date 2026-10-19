// G3 红样本：四条形状规则各一条（params / return-any / empty-catch / console-log）。
export function many(a: string, b: string, c: string, d: string, e: string): string {
	return [a, b, c, d, e].join("");
}

export function anything(): any {
	return 1;
}

export function silent(): void {
	try {
		anything();
	} catch {
	}
}

export function noisy(): void {
	console.log("hi");
}

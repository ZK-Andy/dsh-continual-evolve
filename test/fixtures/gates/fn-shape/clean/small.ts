// G3 绿样本：三参、有类型返回、catch 有处理、无 console。
export function small(a: string, b: string, c: string): string {
	try {
		return [a, b, c].join("");
	} catch {
		return "";
	}
}

// G3 红样本：a → b → a 值导入环（运行时死锁形状）。
import { b } from "./b.js";

export const a = b;

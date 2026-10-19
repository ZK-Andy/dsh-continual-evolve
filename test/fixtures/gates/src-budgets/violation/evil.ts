// G3 红样本：出度 13，超过 12 上限（side-effect 导入，不触发 lint 未使用变量）。
import "./m01.js";
import "./m02.js";
import "./m03.js";
import "./m04.js";
import "./m05.js";
import "./m06.js";
import "./m07.js";
import "./m08.js";
import "./m09.js";
import "./m10.js";
import "./m11.js";
import "./m12.js";
import "./m13.js";

export const evil = 1;

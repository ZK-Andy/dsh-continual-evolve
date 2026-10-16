/**
 * The clock every prompt is anchored to: the run's baseline day and the line
 * that hands it to the model.
 *
 * The model has no clock of its own. A direct LLM call carries an instruction
 * and a user prompt and nothing else — no runtime context, no timestamps — so
 * "is this date in the future?" is answered from the model's own prior unless
 * the caller says otherwise. A run resolves its day once at the boundary and
 * carries it as data, so a replay and a live run see the same prompts.
 */

/**
 * The current UTC day `YYYY-MM-DD`.
 *
 * UTC is the plugin's unit: the review account's day uses the same value, so
 * one run cannot straddle two dates.
 *
 * @returns Today's date in UTC.
 */
export function todayUtc(): string {
	return new Date().toISOString().slice(0, 10);
}

/**
 * The date-baseline line appended to the instruction of a job that makes
 * time-relative judgments.
 *
 * It names the day *and* says which side of it is a defect, because the rule
 * being protected is "no future dates", not "never touch dates": the 2026-10-14
 * trial produced 8 of 13 rewrite verdicts that stripped correct past dates as
 * if they were future ones.
 *
 * @param today - The run's baseline day `YYYY-MM-DD` (UTC).
 * @returns The instruction line to append to a system prompt.
 */
export function dateBaseline(today: string): string {
	return `时间基准：今天是 ${today}（UTC）。正文里早于或等于今天的日期是按期发生的过去事实，不是缺陷、不要据此改写；只有晚于今天的日期才算「未来日期」错误。把相对日期（如"周四"）折算成绝对日期时，以今天为参照。`;
}

/**
 * dsh-chronic-followup — 技能型插件入口。
 * 不注册新工具、不依赖 DSH 内部 API：随包发布一个技能与可直接运行的脚本。
 */
export const name = 'dsh-chronic-followup'

export function apply() {
  // 无副作用：技能由 skills/ 提供，脚本由使用者在会话中按需运行。
}

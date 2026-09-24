/**
 * 统一响应与业务错误工具（类级注释）
 * ------------------------------------------------------------------
 * 核心功能：定义全站统一响应结构 { code, message, data } 与业务异常类 ApiError。
 * 设计思路：controller/service 中只抛 ApiError，由全局错误中间件统一转换为
 *          HTTP 状态码 + 业务错误码（附录 A），对外不泄露堆栈与 SQL 细节。
 * 适用场景：所有 REST 接口的成功/失败响应。
 * 创建时间：2026-09-21
 */

/**
 * 业务异常类（类级注释）
 * 携带 HTTP 状态码、业务错误码与用户可读消息，供全局错误中间件消费。
 * 适用场景：参数校验失败、权限拒绝、业务规则拒绝、唯一性冲突等所有业务异常。
 */
export class ApiError extends Error {
  /**
   * @param {number} status  HTTP 状态码（400/401/403/404/409/423/429/500）
   * @param {number} code    业务错误码（见 PRD 附录 A：1001~1008/5000）
   * @param {string} message 用户可读的错误提示
   * @param {unknown} [details] 可选的字段级错误详情（如 zod 校验结果）
   */
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * 包装成功响应体
 * @param {unknown} data 业务数据（列表类为 { list, total, page, pageSize }）
 * @returns {{code: 0, message: string, data: unknown}} 统一成功响应体
 */
export function ok(data = null, message = 'ok') {
  return { code: 0, message, data };
}

/**
 * 分页参数标准化
 * @param {unknown} query    Express 的 req.query 对象
 * @param {number} [defPage] 默认页码，默认 1
 * @param {number} [defSize] 默认每页条数，默认 20
 * @returns {{page: number, pageSize: number, offset: number}} 标准化后的分页参数
 * @throws {ApiError} page/pageSize 非法（非正整数或超上限 100）时抛 400
 */
export function parsePaging(query, defPage = 1, defSize = 20) {
  let page = parseInt(String(query.page ?? defPage), 10);
  let pageSize = parseInt(String(query.pageSize ?? defSize), 10);
  if (!Number.isInteger(page) || page < 1) page = defPage;
  if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = defSize;
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/**
 * 转义 LIKE 模糊搜索中的通配符（安全修复 VULN-06）
 * 执行逻辑：将用户输入中的 \、%、_ 转义为字面量，配合 SQL 中的
 *          `LIKE ? ESCAPE '\'` 使用，防止攻击者用 %/_ 通配符篡改搜索语义
 *          （如 keyword=% 命中全表），属查询语义加固，非 SQL 注入防护。
 *          注意：SQL 语句必须同时携带 ESCAPE '\' 子句才生效。
 * @param {string} keyword 用户输入的搜索关键词（调用前应已做 trim/长度校验）
 * @returns {string} 转义后的关键词（仅用于 LIKE 参数绑定）
 */
export function escapeLike(keyword) {
  return String(keyword).replace(/[\\%_]/g, (ch) => '\\' + ch);
}

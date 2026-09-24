export const CHANNEL_PREFIX = 'harness-native-chart:v1:';
export const LIMITS = Object.freeze({ sessions: 2, surfaces: 3, samples: 20_000, dimension: 4096, area: 8_000_000 });
export const FRAME_FIELDS = Object.freeze(['frameId', 'width', 'height', 'rawPoints', 'visiblePoints',
  'renderedVertices', 'lodMs', 'encodeMs', 'gpuWaitMs', 'from', 'to', 'yMin', 'yMax']);

export function chartError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function invalid() { throw chartError('INVALID_INPUT', '图表参数不符合白名单协议'); }

export function record(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid();
  const own = Reflect.ownKeys(input);
  if (own.length !== keys.length || keys.some(key => !Object.hasOwn(input, key))
    || own.some(key => !keys.includes(key))) invalid();
}

export function sessionId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value;
}

export function surfaceId(value) {
  if (typeof value !== 'string' || !value.startsWith('chart-')) invalid();
  sessionId(value.slice(6));
  return value;
}

function finiteArray(value, length, predicate = Number.isFinite) {
  if (!Array.isArray(value) || value.length !== length) invalid();
  // 显式按索引检查，避免稀疏数组跳过验证。
  for (let i = 0; i < length; i++) if (!Object.hasOwn(value, i) || !predicate(value[i])) invalid();
  if (Object.keys(value).length !== length) invalid();
}

export function validateOpen(input) {
  record(input, ['surfaceId', 'timestamps', 'values']);
  surfaceId(input.surfaceId);
  const length = input.timestamps?.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > LIMITS.samples) invalid();
  finiteArray(input.timestamps, length);
  finiteArray(input.values, length);
  return input;
}

export function validateRender(input) {
  record(input, ['sessionId', 'width', 'height', 'from', 'to', 'background', 'line', 'requestId']);
  sessionId(input.sessionId);
  for (const dimension of [input.width, input.height]) {
    if (!Number.isSafeInteger(dimension) || dimension < 1 || dimension > LIMITS.dimension) invalid();
  }
  if (input.width * input.height > LIMITS.area || !Number.isFinite(input.from) || !Number.isFinite(input.to)
    || input.to <= input.from || !Number.isFinite(input.to - input.from)
    || !Number.isSafeInteger(input.requestId) || input.requestId < 1) invalid();
  const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
  finiteArray(input.background, 3, byte);
  finiteArray(input.line, 3, byte);
  return input;
}

export function validateHitTest(input) {
  record(input, ['sessionId', 'timestamp']);
  sessionId(input.sessionId);
  if (!Number.isFinite(input.timestamp)) invalid();
  return input;
}

// 显式投影，不让 addon 将来新增的指针字段随展开运算进入 renderer。
export function frameMetrics(frame) {
  const result = {};
  for (const key of FRAME_FIELDS) {
    if (!Number.isFinite(frame?.[key])) throw chartError('NATIVE_FAILURE', '原生帧元数据无效');
    result[key] = frame[key];
  }
  if (!Number.isSafeInteger(result.frameId) || result.frameId < 1
    || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height)
    || result.width < 1 || result.height < 1 || result.width > LIMITS.dimension
    || result.height > LIMITS.dimension || result.width * result.height > LIMITS.area) {
    throw chartError('NATIVE_FAILURE', '原生帧尺寸或租约编号无效');
  }
  return result;
}

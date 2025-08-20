import { Context, Schema, h, segment } from 'koishi'
import { createCanvas, loadImage } from 'canvas'

export const name = 'nailong'

export interface GuildConfig {
  guildId: string
  level: number
  muteTime: number
}

export interface Config {
  baseImages: string[]
  guilds: GuildConfig[]
  defaultLevel: number
  defaultMuteTime: number
  similarity: number
  cooldownTime: number
  probability: number
}

export const Config: Schema<Config> = Schema.object({
  baseImages: Schema.array(Schema.string()).default([]).description('基础图片列表（图片路径或URL）'),
  guilds: Schema.array(Schema.object({
    guildId: Schema.string().required().description('群组ID'),
    level: Schema.natural().min(1).max(3).default(3).description('响应权限级别（1=撤回+禁言，2=撤回，3=响应表情包）'),
    muteTime: Schema.natural().default(60).description('禁言时长（秒）')
  })).default([]).description('启用的群组配置'),
  defaultLevel: Schema.natural().min(1).max(3).default(3).description('默认权限级别'),
  defaultMuteTime: Schema.natural().default(60).description('默认禁言时长（秒）'),
  similarity: Schema.percent().default(0.8).description('图像相似度阈值'),
  cooldownTime: Schema.natural().default(300).description('冷却时间（秒）'),
  probability: Schema.percent().default(0.5).description('响应概率')
})

export function apply(ctx: Context, config: Config) {
  let baseImageData: ImageData | null = null
  const cooldownMap = new Map<string, number>() // 用户冷却记录

  // 加载基础图片
  async function loadBaseImage() {
    if (config.baseImages.length === 0) return
    try {
      const image = await loadImage(config.baseImages[0])
      // 统一调整为固定尺寸
      const canvas = createCanvas(64, 64)
      const canvasCtx = canvas.getContext('2d')
      canvasCtx.drawImage(image, 0, 0, 64, 64)
      baseImageData = canvasCtx.getImageData(0, 0, 64, 64)
      ctx.logger('nailong').info('基础图片加载成功')
    } catch (error) {
      ctx.logger('nailong').warn('加载基础图片失败:', error)
    }
  }

  // 初始化时加载基础图片
  ctx.on('ready', () => {
    loadBaseImage()
  })

  // 检查用户是否在冷却期
  function isUserInCooldown(userId: string): boolean {
    const lastTime = cooldownMap.get(userId)
    if (!lastTime) return false
    return Date.now() - lastTime < config.cooldownTime * 1000
  }

  // 设置用户冷却时间
  function setCooldown(userId: string): void {
    cooldownMap.set(userId, Date.now())
  }

  // 检查是否应该响应（基于概率）
  function shouldRespond(): boolean {
    return Math.random() < config.probability
  }

  // 检查用户权限
  function isAdminOrOwner(session: any): boolean {
    // 检查是否为群主或管理员
    return session.author?.roles?.includes('admin') || session.author?.roles?.includes('owner')
  }

  // 处理不同级别的响应
  async function handleResponse(session: any, level: number, muteTime: number): Promise<void> {
    const { userId, messageId } = session
    const isAdmin = isAdminOrOwner(session)

    try {
      switch (level) {
        case 3:
          // 3级：发送"糖"并引用原消息
          await session.send(h('quote', { id: messageId }) + '糖')
          break

        case 2:
          // 2级：撤回并@发送者（管理员只@不撤回）
          if (!isAdmin) {
            await session.bot.deleteMessage(session.channelId, messageId)
          }
          await session.send(h('at', { id: userId }) + ' 别发你那个唐诗表情包了')
          break

        case 1:
          // 1级：在2级基础上禁言（管理员跳过）
          if (isAdmin) {
            await session.send(h('at', { id: userId }) + ' 别发你那个唐诗表情包了')
          } else {
            await session.bot.deleteMessage(session.channelId, messageId)
            await session.send(h('at', { id: userId }) + ' 别发你那个唐诗表情包了')
            await session.bot.muteGuildMember(session.guildId, userId, muteTime * 1000)
          }
          break
      }
    } catch (error) {
      ctx.logger('nailong').warn('处理响应失败:', error)
    }
  }

  // 获取群配置
  function getGuildConfig(guildId: string): GuildConfig {
    const guildConfig = config.guilds.find(g => g.guildId === guildId)
    return guildConfig || {
      guildId,
      level: config.defaultLevel,
      muteTime: config.defaultMuteTime
    }
  }

  // 检查是否为启用的群
  function isEnabledGuild(guildId: string): boolean {
    return config.guilds.some(g => g.guildId === guildId)
  }

  // 改进的图像相似度比较
  function compareImages(imageData1: ImageData, imageData2: ImageData): number {
    if (!imageData1 || !imageData2) return 0

    const data1 = imageData1.data
    const data2 = imageData2.data

    // 确保数据长度相同
    if (data1.length !== data2.length) return 0

    let totalDiff = 0
    const pixelCount = data1.length / 4 // 每个像素4个值(RGBA)

    for (let i = 0; i < data1.length; i += 4) {
      // 计算RGB差值
      const rDiff = Math.abs(data1[i] - data2[i])
      const gDiff = Math.abs(data1[i + 1] - data2[i + 1])
      const bDiff = Math.abs(data1[i + 2] - data2[i + 2])

      // 计算像素差值的平均值
      const pixelDiff = (rDiff + gDiff + bDiff) / 3
      totalDiff += pixelDiff
    }

    // 计算相似度 (0-1)
    const avgDiff = totalDiff / pixelCount
    const similarity = 1 - (avgDiff / 255)

    return Math.max(0, similarity)
  }

  // 检查是否为表情包（而不是普通图片）
  function isEmoticon(imageUrl: string): boolean {
    // 检查文件大小限制（表情包通常较小）
    // 检查文件类型和路径特征

    // QQ表情包特征
    if (imageUrl.includes('gchat.qpic.cn') ||
      imageUrl.includes('multimedia.nt.qq.com') ||
      imageUrl.includes('emoji') ||
      imageUrl.includes('face') ||
      imageUrl.includes('sticker')) {
      return true
    }

    // 文件名特征（表情包通常有特定的命名模式）
    const fileName = imageUrl.split('/').pop()?.toLowerCase() || ''
    if (fileName.includes('emoji') ||
      fileName.includes('sticker') ||
      fileName.includes('face') ||
      fileName.match(/^[a-f0-9]{32,}\.(gif|png|jpg|jpeg)$/i)) {
      return true
    }

    // 路径特征
    if (imageUrl.includes('/emojis/') ||
      imageUrl.includes('/stickers/') ||
      imageUrl.includes('/faces/')) {
      return true
    }

    return false
  }

  // 检测图像是否为奶龙
  async function detectNailong(imageUrl: string): Promise<boolean> {
    if (!baseImageData) {
      ctx.logger('nailong').warn('基础图片未加载')
      return false
    }

    try {
      const image = await loadImage(imageUrl)
      // 统一调整为相同尺寸
      const canvas = createCanvas(64, 64)
      const canvasCtx = canvas.getContext('2d')
      canvasCtx.drawImage(image, 0, 0, 64, 64)
      const imageData = canvasCtx.getImageData(0, 0, 64, 64)

      const similarity = compareImages(baseImageData, imageData)
      ctx.logger('nailong').info(`图片相似度: ${similarity.toFixed(3)}, 阈值: ${config.similarity}`)

      return similarity >= config.similarity
    } catch (error) {
      ctx.logger('nailong').warn('检测图像失败:', error)
      return false
    }
  }

  // 监听消息
  ctx.middleware(async (session, next) => {
    const { guildId, content, userId } = session

    if (!guildId || !isEnabledGuild(guildId)) return next()

    // 检查用户是否在冷却期
    if (isUserInCooldown(userId)) return next()

    // 检查是否应该响应（基于概率）
    if (!shouldRespond()) return next()

    // 检查消息中的表情包
    const images = h.select(content, 'img')

    if (images.length === 0) return next()

    for (const img of images) {
      const src = img.attrs.src
      if (!src) continue

      // 检查是否为表情包而不是普通图片
      if (!isEmoticon(src)) continue

      const isNailong = await detectNailong(src)

      if (isNailong) {
        // 设置用户冷却
        setCooldown(userId)

        // 获取群配置并处理响应
        const guildConfig = getGuildConfig(guildId)
        await handleResponse(session, guildConfig.level, guildConfig.muteTime)

        break // 只处理第一张匹配的图片
      }
    } return next()
  })
}
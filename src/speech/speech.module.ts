/**
 * 语音模块（SpeechModule）
 * - 聚合语音相关能力（ASR 语音识别、TTS 转发）
 * - 通过 NestJS DI 提供腾讯云 ASR 客户端实例（token: 'ASR_CLIENT'）
 * - 暴露 TtsRelayService 供其他模块复用
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SpeechService } from './speech.service';
import { SpeechController } from './speech.controller';
import { TtsRelayService } from './tts-relay.service';
// 引入腾讯云 Node.js SDK，用于创建 ASR 客户端
import * as tencentcloud from 'tencentcloud-sdk-nodejs';

// 将腾讯云 ASR 指定版本的 Client 取别名，便于后续实例化
const AsrClient = tencentcloud.asr.v20190614.Client;

@Module({
  providers: [
    SpeechService,
    TtsRelayService,
    {
      // 使用自定义 DI Token 暴露 ASR 客户端，方便在 Service 中通过 @Inject('ASR_CLIENT') 使用
      provide: 'ASR_CLIENT',
      useFactory: (configService: ConfigService) => {
        // 基于配置中心提供的密钥与网络参数构造 ASR 客户端
        // 请确保在配置源（.env 或配置中心）中存在 SECRET_ID / SECRET_KEY
        return new AsrClient({
          credential: {
            secretId: configService.get<string>('SECRET_ID'),
            secretKey: configService.get<string>('SECRET_KEY'),
          },
          // 区域按实际资源归属调整，例如：ap-shanghai、ap-guangzhou 等
          region: 'ap-shanghai',
          profile: {
            httpProfile: {
              // 使用 POST 以兼容较大请求体
              reqMethod: 'POST',
              // 单次请求超时时间（秒）
              reqTimeout: 30,
            },
          },
        });
      },
      // 注入 ConfigService，以便从环境或配置中心读取密钥等配置
      inject: [ConfigService],
    },
  ],
  // 控制器负责对外暴露 HTTP 接口
  controllers: [SpeechController],
  // 导出 TtsRelayService 以便其他模块可复用 TTS 转发能力
  exports: [TtsRelayService],
})
export class SpeechModule {}

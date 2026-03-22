import { Module, forwardRef } from '@nestjs/common';
import { JobService } from './job.service';
import { JobAgentService } from 'src/ai/job-agent.service';
import { ToolModule } from 'src/tool/tool.module';

@Module({
  imports: [forwardRef(() => ToolModule)],
  providers: [JobService, JobAgentService],
  exports: [JobService],
})
export class JobModule {}

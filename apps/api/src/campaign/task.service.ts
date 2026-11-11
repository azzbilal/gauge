import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskDto } from './dto/task.dto';
import { CreateTaskReviewDto } from './dto/task-review.dto';

@Injectable()
export class TaskService {
  constructor(private readonly prisma: PrismaService) {}

  list(campaignId?: string) {
    return this.prisma.task.findMany({
      where: campaignId ? { campaignId } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        campaign: { select: { id: true, name: true } },
        author: { select: { id: true, name: true } },
        taskReviews: true,
      },
    });
  }

  async get(id: string) {
    const task = await this.prisma.task.findUnique({
      where: { id },
      include: { campaign: true, author: true, taskReviews: true },
    });
    if (!task) {
      throw new NotFoundException(`Task "${id}" not found`);
    }
    return task;
  }

  async create(dto: CreateTaskDto) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: dto.campaignId } });
    if (!campaign) {
      throw new NotFoundException(`Campaign "${dto.campaignId}" not found`);
    }
    const author = await this.prisma.expert.findUnique({ where: { id: dto.authorId } });
    if (!author) {
      throw new NotFoundException(`Author (expert) "${dto.authorId}" not found`);
    }

    const task = await this.prisma.task.create({
      data: {
        campaignId: dto.campaignId,
        authorId: dto.authorId,
        prompt: dto.prompt,
        spec: dto.spec ?? null,
        reference: dto.reference ?? null,
        status: TaskStatus.SUBMITTED,
      },
    });

    await this.prisma.event.create({
      data: {
        actorId: dto.authorId,
        type: 'task.created',
        payload: { taskId: task.id, campaignId: dto.campaignId } as Prisma.InputJsonValue,
      },
    });

    return task;
  }

  async review(taskId: string, dto: CreateTaskReviewDto) {
    const task = await this.prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundException(`Task "${taskId}" not found`);
    }

    const review = await this.prisma.taskReview.create({
      data: {
        taskId,
        reviewerId: dto.reviewerId,
        scores: dto.scores as Prisma.InputJsonValue,
        accepted: dto.accepted,
      },
    });

    await this.prisma.task.update({
      where: { id: taskId },
      data: { status: dto.accepted ? TaskStatus.ACCEPTED : TaskStatus.REJECTED },
    });

    // The reviewer may not be an Expert row, so the event actor stays null and
    // reviewerId is kept in the payload.
    await this.prisma.event.create({
      data: {
        actorId: null,
        type: 'task.reviewed',
        payload: {
          taskId,
          reviewId: review.id,
          reviewerId: dto.reviewerId,
          accepted: dto.accepted,
        } as Prisma.InputJsonValue,
      },
    });

    return review;
  }
}

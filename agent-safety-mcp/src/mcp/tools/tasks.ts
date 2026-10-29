/**
 * Task Management Tools
 */

import { TaskService } from "../../core/task.service";

export interface ToolWithHandler {
  name: string;
  description?: string;
  inputSchema: any;
  _handler: (args: any) => Promise<any>;
}

export function getTaskServiceTools(service: TaskService): ToolWithHandler[] {
  const tools: ToolWithHandler[] = [];

  tools.push({
    name: "create_task",
    description: "Create a new task for an agent",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        description: { type: "string" },
        metadata: { type: "object" },
        taskKey: { type: "string" },
      },
      required: ["agentId", "description"],
    },
    _handler: async (args: any) =>
      await service.createTask(
        args.agentId,
        args.description,
        args.metadata,
        args.taskKey
      ),
  });

  tools.push({
    name: "get_task",
    description: "Get task by ID or key",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        taskId: { type: "string" },
        taskKey: { type: "string" },
      },
      required: [],
    },
    _handler: async (args: any) => {
      let task;
      if (args.taskId) task = service.getTask(args.taskId);
      else if (args.taskKey) task = service.getTaskByKey(args.taskKey);
      if (!task) throw new Error("Task not found");
      return task;
    },
  });

  tools.push({
    name: "update_task_status",
    description: "Update task status",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "failed"],
        },
      },
      required: ["taskId", "status"],
    },
    _handler: async (args: any) => {
      const task = await service.updateTaskStatus(args.taskId, args.status);
      if (!task) throw new Error(`Task not found: ${args.taskId}`);
      return task;
    },
  });

  tools.push({
    name: "list_tasks",
    description: "List tasks by agent or status",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        status: { type: "string" },
      },
      required: ["agentId"],
    },
    _handler: async (args: any) => {
      const tasks = service.listTasksByAgent(args.agentId).filter(
        (task) => !args.status || task.status === args.status
      );
      return { tasks };
    },
  });

  return tools;
}


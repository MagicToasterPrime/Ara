export interface ChatAttachment {
  kind: "DOCUMENT" | "WHITEBOARD";
  id: string;
  title: string;
  ueId?: string | null;
  ueCode?: string | null;
  fileName?: string;
}

export interface ChatMessagePayload {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  attachmentJson: string | null;
  createdAt: string;
  author: {
    id: string;
    name: string;
    globalRole: "STUDENT" | "YEAR_ADMIN";
  };
}

export interface WhiteboardCollaborator {
  socketId: string;
  userId: string;
  userName: string;
  color: string;
  x?: number;
  y?: number;
}

export interface WhiteboardCursorPayload {
  whiteboardId: string;
  userId: string;
  userName: string;
  color: string;
  x: number;
  y: number;
}

export interface WhiteboardUpdatePayload {
  whiteboardId: string;
  userId: string;
  snapshot: string;
}

import { Tag } from 'antd';
import type { AppointmentStatus } from '../api/client';

const STATUS_META: Record<AppointmentStatus, { color: string; label: string }> = {
  pending: { color: 'gold', label: '待确认' },
  confirmed: { color: 'blue', label: '已确认' },
  checked_in: { color: 'cyan', label: '已到店' },
  completed: { color: 'green', label: '已完成' },
  cancelled: { color: 'red', label: '已取消' },
  no_show: { color: 'purple', label: '爽约' },
};

export function StatusTag({ status }: { status: AppointmentStatus }) {
  const meta = STATUS_META[status] ?? { color: 'default', label: status };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export const STATUS_OPTIONS = Object.entries(STATUS_META).map(([value, meta]) => ({ value, label: meta.label }));
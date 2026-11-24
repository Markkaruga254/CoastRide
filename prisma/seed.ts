import { PrismaClient } from '@prisma/client';
import { getEnv } from '../src/config/env.js';

const prisma = new PrismaClient();

const DEFAULT_PHONES = [
  '+254700000001',
  '+254700000002',
  '+254700000003',
  '+254700000004',
];

const drivers = [
  { name: 'Alice Wanjiku', plate: 'KBA 123A', vehicle: 'Toyota Noah' },
  { name: 'Brian Otieno', plate: 'KBC 456B', vehicle: 'Toyota Voxy' },
  { name: 'Catherine Njeri', plate: 'KBD 789C', vehicle: 'Toyota Hiace' },
  { name: 'David Omondi', plate: 'KBE 012D', vehicle: 'Toyota Wish' },
];

async function main() {
  const env = getEnv();
  const rawPhones = env.SEED_DRIVER_PHONES ?? DEFAULT_PHONES.join(',');
  const phones = rawPhones
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  if (phones.length < drivers.length) {
    throw new Error(
      `SEED_DRIVER_PHONES must provide at least ${drivers.length} phones, got ${phones.length}`,
    );
  }

  for (let i = 0; i < drivers.length; i++) {
    await prisma.driver.upsert({
      where: { phone: phones[i] },
      update: {},
      create: { ...drivers[i], phone: phones[i] },
    })
  }

  const created = await prisma.driver.findMany({
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  console.log(
    `Seeded ${created.length} drivers:`,
    created.map((d) => `${d.name} (${d.phone})`).join(', '),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

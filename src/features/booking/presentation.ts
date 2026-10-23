const rubles = new Intl.NumberFormat('ru-RU');

export const money = (value: number) => rubles.format(value) + '\u00a0₽';
export const ageText = (age: number) =>
  `${age} ${age % 100 >= 11 && age % 100 <= 14 ? 'лет' : age % 10 === 1 ? 'год' : age % 10 >= 2 && age % 10 <= 4 ? 'года' : 'лет'}`;
export const ticketCount = (count: number) =>
  `${count} ${count === 1 ? 'билет' : count >= 2 && count <= 4 ? 'билета' : 'билетов'}`;

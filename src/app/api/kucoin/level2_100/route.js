import { NextResponse } from 'next/server';
import { headers } from 'next/headers';
import axios from 'axios';
import { KUCOIN_API_URL } from '../../../../webhelpers/constants';

export async function GET(request, response) {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol');
  const headersList = await headers();
  const forwardedFor = headersList.get('x-forwarded-for');
  const realIp = headersList.get('x-real-ip');
  const clientIp = forwardedFor?.split(',')[0] || realIp || 'unknown';
  try {
    const response = await axios.get(`${KUCOIN_API_URL}/market/orderbook/level2_100`, {
      params: {
        symbol: symbol
      },
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': clientIp,
        'X-Real-IP': clientIp,
      }
    });
    return NextResponse.json(response.data);
  } catch (error) {
    console.error('Error proxying Kucoin API request:', error);
    return NextResponse.json(
      { error: 'Failed to fetch data from Kucoin' },
      { status: 500 }
    );
  }
} 
